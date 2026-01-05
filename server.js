// Importar librerías necesarias
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const { MongoClient, ObjectId } = require('mongodb');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const pdfParse = require('pdf-parse');
const PDFParser = require('pdf2json');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const Tesseract = require('tesseract.js');

// Configuración
const app = express();
const PORT = process.env.PORT || 3000;

// Inicializar cliente de Groq
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Configuración de Multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = './uploads';
    try {
      await fs.mkdir(uploadDir, { recursive: true });
    } catch (error) {
      console.error('Error creando carpeta uploads:', error);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|doc|docx|xls|xlsx|jpg|jpeg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Tipo de archivo no permitido'));
  }
});

// Conexión a MongoDB
let db;
const mongoUri = process.env.MONGODB_URI;

const mongoClient = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

async function connectDB() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('autoevaluacion_academica');
    console.log('✅ Conectado a MongoDB Atlas - Base: autoevaluacion_academica');
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Contexto institucional
const contextoInstitucional = {
  proposito: "Espacio tecnológico institucional para la autoevaluación de programas académicos",
  enfoque: "Integra evidencias y análisis según normatividad del MEN y CNA",
  orientacion: "Calidad, logros, resultados e impactos"
};

// Instrucciones académicas
const instruccionesAcademicas = `Eres un asistente académico virtual especializado en autoevaluación de programas académicos según normatividad MEN y CNA de Colombia.

**IMPORTANTE: CONSULTA DEL REPOSITORIO NORMATIVO**
Tienes acceso a un REPOSITORIO INSTITUCIONAL de documentos normativos que contiene el CONTENIDO COMPLETO de decretos, resoluciones, lineamientos del CNA y documentos institucionales oficiales. 

PROTOCOLO DE CONSULTA OBLIGATORIO:
1. SIEMPRE lee PRIMERO el contenido completo del documento en el repositorio, NO solo el análisis preliminar
2. Si el repositorio contiene el documento mencionado en la pregunta, úsalo como fuente primaria
3. Cita EXPLÍCITAMENTE: "[Verificado en repositorio institucional - nombre_del_documento.pdf]"
4. Si el contenido del repositorio es insuficiente, decláralo: "[Requiere verificación adicional en fuente primaria MEN/CNA]"
5. Complementa con búsqueda en línea cuando sea necesario

EJEMPLO DE RESPUESTA CORRECTA:
"[Verificado en repositorio institucional - Decreto_1330_2019.pdf] Según el artículo 3 del Decreto 1330 de 2019, las condiciones institucionales son: a) Mecanismos de selección y evaluación..."

NO respondas "no se menciona" si el documento está en el repositorio. Lee el CONTENIDO COMPLETO primero.

PRINCIPIOS DE VERIFICACIÓN:
• No presentar contenido inferido como hecho verificado
• Verificar información en base de conocimientos antes de usarla
• Priorizar fuentes normativas oficiales (MEN, CNA, CESU)
• Declarar explícitamente cuando no puedas verificar información
• Solicitar información faltante; no completar vacíos por inferencia

SISTEMA DE ETIQUETADO OBLIGATORIO:
Cada afirmación debe iniciar con:
• [Verificado en base de conocimientos]
• [Inferencia]
• [Especulación]
• [Requiere verificación en fuente primaria MEN/CNA]
• [Búsqueda requerida]

Las palabras Prevenir, Garantizar, Nunca, Arregla, Eliminar, Asegurar exigen fuente normativa explícita.

ANÁLISIS DE DOCUMENTOS:
• Lee cuidadosamente TODO el contenido del documento
• Identifica elementos clave: normatividad citada, factores, características, evidencias
• Resume de forma estructurada y precisa
• Señala inconsistencias o vacíos normativos
• Relaciona con lineamientos MEN/CNA vigentes

ESTILO:
• Lenguaje técnico académico
• Coherente con informes de autoevaluación
• Evitar redundancias
• Densidad informativa alta

REFERENCIACIÓN: APA 7.ª edición prioritariamente.`;


// ========== SISTEMA DE ANÁLISIS AVANZADO CON IA ==========

// FUNCIÓN: Dividir texto largo en chunks manejables
function dividirEnChunks(texto, maxTokens = 12000) {
  const palabras = texto.split(/\s+/);
  const chunks = [];
  let chunkActual = [];
  let contadorPalabras = 0;

  for (const palabra of palabras) {
    chunkActual.push(palabra);
    contadorPalabras++;

    // Aproximadamente 1 token = 0.75 palabras en español
    if (contadorPalabras >= maxTokens * 0.75) {
      chunks.push(chunkActual.join(' '));
      chunkActual = [];
      contadorPalabras = 0;
    }
  }

  if (chunkActual.length > 0) {
    chunks.push(chunkActual.join(' '));
  }

  return chunks;
}

// FUNCIÓN: Extracción de entidades normativas
async function extraerEntidadesNormativas(texto) {
  try {
    const promptEntidades = `Analiza el siguiente texto y extrae ÚNICAMENTE estas entidades normativas específicas en formato JSON:

{
  "decretos": ["número y año"],
  "resoluciones": ["número y año"],
  "leyes": ["número y año"],
  "acuerdos": ["número y año"],
  "factoresCNA": ["número de factor mencionado"],
  "caracteristicasCNA": ["número de característica"],
  "articulos": ["artículos citados"],
  "fechasImportantes": ["fechas de vigencia o expedición"],
  "institucionesResponsables": ["MEN, CNA, CESU, etc."]
}

Texto a analizar:
${texto.substring(0, 8000)}

Responde ÚNICAMENTE con el JSON, sin texto adicional.`;

    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Eres un extractor especializado de entidades normativas. Responde únicamente en formato JSON válido.'
        },
        {
          role: 'user',
          content: promptEntidades
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 1000
    });

    const resultado = response.choices[0].message.content;
    
    try {
      return JSON.parse(resultado);
    } catch {
      // Si no es JSON válido, extraer manualmente
      return {
        decretos: extraerPatron(texto, /decreto\s+(\d+)\s+de\s+(\d{4})/gi),
        resoluciones: extraerPatron(texto, /resoluci[oó]n\s+(\d+)\s+de\s+(\d{4})/gi),
        leyes: extraerPatron(texto, /ley\s+(\d+)\s+de\s+(\d{4})/gi),
        factoresCNA: extraerPatron(texto, /factor\s+(\d+)/gi),
        caracteristicasCNA: extraerPatron(texto, /caracter[ií]stica\s+(\d+)/gi)
      };
    }
  } catch (error) {
    console.error('Error extrayendo entidades:', error.message);
    return {};
  }
}

// FUNCIÓN: Extraer patrones con regex
function extraerPatron(texto, patron) {
  const matches = [];
  let match;
  while ((match = patron.exec(texto)) !== null) {
    matches.push(match[0]);
  }
  return [...new Set(matches)]; // Eliminar duplicados
}

// FUNCIÓN: Análisis estructural del documento
async function analizarEstructuraDocumento(texto, nombreArchivo) {
  try {
    const promptEstructura = `Analiza la estructura formal de este documento académico/normativo:

Documento: ${nombreArchivo}

ESTRUCTURA A IDENTIFICAR:
1. Tipo de documento (Decreto, Resolución, Informe, Plan, Guía, etc.)
2. Secciones principales identificadas (Introducción, Capítulos, Artículos, etc.)
3. Nivel de formalidad (Normativo oficial / Documento institucional / Informe técnico)
4. Completitud (¿Tiene todos los elementos esperados?)
5. Ámbito de aplicación (Nacional / Institucional / Por programa)

Contenido del documento (primeras 5000 palabras):
${texto.substring(0, 20000)}

Responde en formato estructurado con secciones claras.`;

    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Eres un analista de documentos académicos experto en normatividad colombiana de educación superior.'
        },
        {
          role: 'user',
          content: promptEstructura
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 1500
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error en análisis estructural:', error.message);
    return '[Error en análisis estructural]';
  }
}

// FUNCIÓN: Análisis de contenido normativo específico
async function analizarContenidoNormativo(texto, tipoDocumento) {
  try {
    const promptContenido = `Como experto en normatividad del MEN y CNA, analiza el siguiente documento:

Tipo de documento: ${tipoDocumento}

INSTRUCCIONES DE ANÁLISIS PROFUNDO:
1. Identifica los REQUISITOS clave establecidos
2. Detecta OBLIGACIONES específicas para las IES
3. Encuentra PLAZOS y fechas de cumplimiento
4. Identifica EVIDENCIAS que se deben presentar
5. Detecta INDICADORES de evaluación mencionados
6. Señala PROCEDIMIENTOS descritos
7. Identifica RESPONSABLES de implementación
8. Detecta REFERENCIAS a otros documentos normativos
9. Realiza un RESUMEN COMPLETO del documento

Contenido del documento:
${texto.substring(0, 15000)}

FORMATO DE RESPUESTA ESPERADO:
## Requisitos Clave
[Lista estructurada]

## Obligaciones para IES
[Lista con etiquetas de certeza]

## Plazos y Fechas
[Lista cronológica]

## Evidencias Requeridas
[Lista detallada]

## Indicadores de Evaluación
[Lista numerada]

## Referencias Normativas
[Lista con números de norma]

Aplica etiquetas [Verificado], [Inferencia] o [Requiere verificación] según corresponda.`;

    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: instruccionesAcademicas
        },
        {
          role: 'user',
          content: promptContenido
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 2048
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error en análisis de contenido:', error.message);
    return '[Error en análisis de contenido normativo]';
  }
}

// FUNCIÓN: Evaluación de calidad del documento
async function evaluarCalidadDocumento(texto, tipoDocumento, metadata) {
  try {
    const analisis = {
      longitudTexto: texto.length,
      palabrasEstimadas: texto.split(/\s+/).length,
      tieneFechas: /\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/.test(texto),
      tieneNormatividad: /decreto|resoluci[oó]n|ley|acuerdo/gi.test(texto),
      tieneFactoresCNA: /factor\s+\d+/gi.test(texto),
      tieneCaracteristicas: /caracter[ií]stica\s+\d+/gi.test(texto),
      tieneTablas: /tabla|cuadro/gi.test(texto),
      tieneCitas: /\d{4}\)|\[\d+\]/.test(texto)
    };

    // Calcular score de calidad (0-100)
    let score = 0;
    if (analisis.longitudTexto > 1000) score += 20;
    if (analisis.palabrasEstimadas > 500) score += 15;
    if (analisis.tieneFechas) score += 10;
    if (analisis.tieneNormatividad) score += 20;
    if (analisis.tieneFactoresCNA) score += 15;
    if (analisis.tieneCaracteristicas) score += 10;
    if (analisis.tieneCitas) score += 10;

    analisis.scoreCalidad = Math.min(score, 100);
    
    // Clasificación de calidad
    if (analisis.scoreCalidad >= 80) {
      analisis.clasificacion = 'Excelente';
    } else if (analisis.scoreCalidad >= 60) {
      analisis.clasificacion = 'Bueno';
    } else if (analisis.scoreCalidad >= 40) {
      analisis.clasificacion = 'Regular';
    } else {
      analisis.clasificacion = 'Requiere mejora';
    }

    // Recomendaciones
    analisis.recomendaciones = [];
    if (!analisis.tieneFechas) {
      analisis.recomendaciones.push('Agregar fechas de expedición/vigencia');
    }
    if (!analisis.tieneNormatividad) {
      analisis.recomendaciones.push('Incluir referencias normativas (decretos, resoluciones)');
    }
    if (analisis.longitudTexto < 1000) {
      analisis.recomendaciones.push('Ampliar el contenido del documento');
    }
    if (!analisis.tieneCitas) {
      analisis.recomendaciones.push('Agregar referencias bibliográficas');
    }

    return analisis;
  } catch (error) {
    console.error('Error evaluando calidad:', error.message);
    return { scoreCalidad: 0, clasificacion: 'Error', recomendaciones: [] };
  }
}

// FUNCIÓN: Análisis completo mejorado (REEMPLAZA la anterior)
async function analizarDocumentoConIA(contenido, nombreArchivo, tipoDocumento) {
  try {
    console.log(`🔬 Iniciando análisis avanzado de: ${nombreArchivo}`);
    
    const resultadoAnalisis = {
      timestamp: new Date().toISOString(),
      nombreArchivo: nombreArchivo,
      tipoDocumento: tipoDocumento
    };

    // 1. EXTRAER ENTIDADES NORMATIVAS
    console.log('📋 Extrayendo entidades normativas...');
    resultadoAnalisis.entidades = await extraerEntidadesNormativas(contenido);

    // 2. ANÁLISIS ESTRUCTURAL
    console.log('🏗️ Analizando estructura del documento...');
    resultadoAnalisis.analisisEstructural = await analizarEstructuraDocumento(contenido, nombreArchivo);

    // 3. ANÁLISIS DE CONTENIDO NORMATIVO
    console.log('⚖️ Analizando contenido normativo...');
    resultadoAnalisis.analisisContenido = await analizarContenidoNormativo(contenido, tipoDocumento);

    // 4. EVALUACIÓN DE CALIDAD
    console.log('📊 Evaluando calidad del documento...');
    resultadoAnalisis.evaluacionCalidad = await evaluarCalidadDocumento(contenido, tipoDocumento, {});

    // 5. RESUMEN EJECUTIVO
    console.log('📝 Generando resumen ejecutivo...');
    const promptResumen = `Genera un resumen ejecutivo de 3-5 párrafos del siguiente documento:

Tipo: ${tipoDocumento}
Documento: ${nombreArchivo}

Contenido:
${contenido.substring(0, 10000)}

El resumen debe:
- Identificar el propósito principal del documento
- Mencionar los elementos normativos clave
- Señalar obligaciones o requisitos principales
- Indicar a quién aplica
- Aplicar etiquetas de certeza apropiadas

Formato académico profesional.`;

    const resumenResponse = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: instruccionesAcademicas },
        { role: 'user', content: promptResumen }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 1024
    });

    resultadoAnalisis.resumenEjecutivo = resumenResponse.choices[0].message.content;

    // 6. FORMATEAR RESULTADO FINAL
    const analisisCompleto = `
═══════════════════════════════════════════════════════════════
📊 ANÁLISIS AVANZADO DEL DOCUMENTO
═══════════════════════════════════════════════════════════════

📄 DOCUMENTO: ${nombreArchivo}
📋 TIPO: ${tipoDocumento}
⏰ FECHA DE ANÁLISIS: ${new Date().toLocaleString('es-CO')}

═══════════════════════════════════════════════════════════════
📝 RESUMEN EJECUTIVO
═══════════════════════════════════════════════════════════════

${resultadoAnalisis.resumenEjecutivo}

═══════════════════════════════════════════════════════════════
🏗️ ANÁLISIS ESTRUCTURAL
═══════════════════════════════════════════════════════════════

${resultadoAnalisis.analisisEstructural}

═══════════════════════════════════════════════════════════════
⚖️ ANÁLISIS DE CONTENIDO NORMATIVO
═══════════════════════════════════════════════════════════════

${resultadoAnalisis.analisisContenido}

═══════════════════════════════════════════════════════════════
📋 ENTIDADES NORMATIVAS IDENTIFICADAS
═══════════════════════════════════════════════════════════════

${formatearEntidades(resultadoAnalisis.entidades)}

═══════════════════════════════════════════════════════════════
📊 EVALUACIÓN DE CALIDAD DEL DOCUMENTO
═══════════════════════════════════════════════════════════════

🎯 Score de Calidad: ${resultadoAnalisis.evaluacionCalidad.scoreCalidad}/100
📈 Clasificación: ${resultadoAnalisis.evaluacionCalidad.clasificacion}
📏 Extensión: ${resultadoAnalisis.evaluacionCalidad.palabrasEstimadas} palabras

${resultadoAnalisis.evaluacionCalidad.recomendaciones.length > 0 ? `
💡 RECOMENDACIONES DE MEJORA:
${resultadoAnalisis.evaluacionCalidad.recomendaciones.map((r, i) => `${i + 1}. ${r}`).join('\n')}
` : '✅ El documento cumple con los estándares de calidad esperados.'}

═══════════════════════════════════════════════════════════════
`;

    console.log('✅ Análisis avanzado completado');
    return analisisCompleto;

  } catch (error) {
    console.error('❌ Error en análisis avanzado:', error);
    return `[Error en análisis avanzado: ${error.message}]\n\nSe guardó el documento pero el análisis detallado no está disponible.`;
  }
}

// FUNCIÓN: Formatear entidades extraídas
function formatearEntidades(entidades) {
  if (!entidades || Object.keys(entidades).length === 0) {
    return '[No se identificaron entidades normativas específicas]';
  }

  let resultado = '';
  
  if (entidades.decretos && entidades.decretos.length > 0) {
    resultado += `📜 Decretos: ${entidades.decretos.join(', ')}\n`;
  }
  if (entidades.resoluciones && entidades.resoluciones.length > 0) {
    resultado += `📋 Resoluciones: ${entidades.resoluciones.join(', ')}\n`;
  }
  if (entidades.leyes && entidades.leyes.length > 0) {
    resultado += `⚖️ Leyes: ${entidades.leyes.join(', ')}\n`;
  }
  if (entidades.factoresCNA && entidades.factoresCNA.length > 0) {
    resultado += `🎯 Factores CNA: ${entidades.factoresCNA.join(', ')}\n`;
  }
  if (entidades.caracteristicasCNA && entidades.caracteristicasCNA.length > 0) {
    resultado += `✅ Características CNA: ${entidades.caracteristicasCNA.join(', ')}\n`;
  }
  if (entidades.institucionesResponsables && entidades.institucionesResponsables.length > 0) {
    resultado += `🏛️ Instituciones: ${entidades.institucionesResponsables.join(', ')}\n`;
  }

  return resultado || '[Entidades no estructuradas detectadas]';
}


// FUNCIÓN: Extraer texto mejorado con manejo de errores
async function extraerTextoDeArchivo(filepath, mimetype) {
  try {
    console.log('Extrayendo texto de: ' + filepath + ' (tipo: ' + mimetype + ')');

if (mimetype === 'application/pdf') {
  try {
    console.log('=== INICIANDO EXTRACCION DE PDF ===');
    const dataBuffer = await fs.readFile(filepath);
    let textoExtraido = '';
    let numPaginas = 0;
    let metodoExitoso = '';
    
    // METODO 1: pdf-parse (Mas rapido, funciona con PDFs simples)
    try {
      console.log('Metodo 1: Intentando pdf-parse...');
      const data = await pdfParse(dataBuffer);
      if (data.text && data.text.trim().length > 100) {
        textoExtraido = data.text;
        numPaginas = data.numpages;
        metodoExitoso = 'pdf-parse';
        console.log('Exito con pdf-parse: ' + textoExtraido.length + ' caracteres, ' + numPaginas + ' paginas');
      } else {
        console.log('pdf-parse extrajo texto insuficiente: ' + (data.text ? data.text.length : 0) + ' caracteres');
      }
    } catch (parseError) {
      console.log('pdf-parse fallo: ' + parseError.message);
    }
    
    // METODO 2: pdfjs-dist (Mas robusto, mejor para PDFs complejos)
    if (!textoExtraido) {
      try {
        console.log('Metodo 2: Intentando pdfjs-dist...');
        const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');
        
        const loadingTask = getDocument({
          data: new Uint8Array(dataBuffer),
          useSystemFonts: true
        });
        
        const pdfDocument = await loadingTask.promise;
        numPaginas = pdfDocument.numPages;
        console.log('PDF cargado con pdfjs-dist: ' + numPaginas + ' paginas');
        
        let fullText = '';
        for (let i = 1; i <= numPaginas; i++) {
          const page = await pdfDocument.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map(item => item.str).join(' ');
          fullText += pageText + '\n\n';
        }
        
        if (fullText.trim().length > 100) {
          textoExtraido = fullText;
          metodoExitoso = 'pdfjs-dist';
          console.log('Exito con pdfjs-dist: ' + textoExtraido.length + ' caracteres');
        } else {
          console.log('pdfjs-dist extrajo texto insuficiente: ' + fullText.length + ' caracteres');
        }
      } catch (pdfjsError) {
        console.log('pdfjs-dist fallo: ' + pdfjsError.message);
      }
    }
    
    // METODO 3: pdf2json (Alternativa para PDFs con encoding especial)
    if (!textoExtraido) {
      try {
        console.log('Metodo 3: Intentando pdf2json...');
        const PDFParser = require('pdf2json');
        const pdfParser = new PDFParser();
        let textoAlternativo = '';
        
        await new Promise((resolve, reject) => {
          pdfParser.on('pdfParser_dataError', errData => {
            console.log('pdf2json error: ' + errData.parserError);
            reject(errData.parserError);
          });
          
          pdfParser.on('pdfParser_dataReady', pdfData => {
            const pages = pdfData.Pages || [];
            numPaginas = pages.length;
            pages.forEach(page => {
              const texts = page.Texts || [];
              texts.forEach(text => {
                if (text.R && text.R[0] && text.R[0].T) {
                  textoAlternativo += decodeURIComponent(text.R[0].T) + ' ';
                }
              });
            });
            resolve();
          });
          
          pdfParser.parseBuffer(dataBuffer);
        });
        
        if (textoAlternativo.trim().length > 100) {
          textoExtraido = textoAlternativo;
          metodoExitoso = 'pdf2json';
          console.log('Exito con pdf2json: ' + textoExtraido.length + ' caracteres');
        } else {
          console.log('pdf2json extrajo texto insuficiente: ' + textoAlternativo.length + ' caracteres');
        }
      } catch (pdf2jsonError) {
        console.log('pdf2json fallo: ' + pdf2jsonError.message);
      }
    }
    
 // METODO 4: OCR deshabilitado para PDFs (solo funciona con imagenes)
if (!textoExtraido) {
  console.log('Metodo 4: OCR omitido para PDFs');
  console.log('NOTA: Tesseract solo puede procesar imagenes (PNG, JPG), no PDFs directamente');
  console.log('RECOMENDACION: Si el PDF no se extrae, proporciona el documento en formato Word (.docx) o convierte cada pagina a imagen PNG');
}
   
    // RESULTADO FINAL
    if (textoExtraido) {
      console.log('=== EXTRACCION EXITOSA ===');
      console.log('Metodo: ' + metodoExitoso);
      console.log('Caracteres extraidos: ' + textoExtraido.length);
      console.log('Palabras aproximadas: ' + Math.round(textoExtraido.split(/\s+/).length));
      return {
        texto: textoExtraido,
        paginas: numPaginas || 1,
        metadata: { 
          metodo: metodoExitoso,
          caracteresExtraidos: textoExtraido.length
        }
      };
    } else {
      console.log('=== TODOS LOS METODOS FALLARON ===');
      return {
        texto: '[ERROR: No se pudo extraer texto del PDF con ningun metodo disponible. El archivo puede estar protegido, corrupto o ser una imagen sin OCR efectivo. Por favor, proporciona el documento en formato Word (.docx) o como texto plano (.txt)]',
        paginas: numPaginas || null,
        metadata: { error: 'Todos los metodos de extraccion fallaron' }
      };
    }
    
  } catch (pdfError) {
    console.error('Error general procesando PDF:', pdfError.message);
    return {
      texto: '[Error al procesar PDF: ' + pdfError.message + '. Intenta con formato Word (.docx) o texto plano (.txt)]',
      paginas: null,
      metadata: { error: pdfError.message }
    };
  }
}

if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
  try {
    console.log('Extrayendo texto de documento Word...');
    const result = await mammoth.extractRawText({ path: filepath });
    const textoWord = result.value || '';
    console.log('Word extraido: ' + textoWord.length + ' caracteres');
    return {
      texto: textoWord || '[Documento Word sin texto extraible]',
      paginas: null,
      metadata: { metodo: 'mammoth' }
    };
  } catch (wordError) {
    console.error('Error procesando Word:', wordError.message);
    return {
      texto: '[Error al procesar documento Word: ' + wordError.message + ']',
      paginas: null,
      metadata: { error: wordError.message }
    };
  }
}

if (mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimetype === 'application/vnd.ms-excel') {
  try {
    console.log('Extrayendo texto de documento Excel...');
    const workbook = xlsx.readFile(filepath);
    let texto = '';
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      texto += '\n[Hoja: ' + sheetName + ']\n';
      texto += xlsx.utils.sheet_to_txt(sheet) + '\n';
    });
    console.log('Excel extraido: ' + texto.length + ' caracteres, ' + workbook.SheetNames.length + ' hojas');
    return {
      texto: texto || '[Documento Excel sin contenido extraible]',
      paginas: workbook.SheetNames.length,
      metadata: { hojas: workbook.SheetNames, metodo: 'xlsx' }
    };
  } catch (excelError) {
    console.error('Error procesando Excel:', excelError.message);
    return {
      texto: '[Error al procesar Excel: ' + excelError.message + ']',
      paginas: null,
      metadata: { error: excelError.message }
    };
  }
}

if (mimetype.startsWith('image/')) {
  try {
    console.log('Aplicando OCR a imagen...');
    const { data: { text } } = await Tesseract.recognize(filepath, 'spa', {
      logger: info => {
        if (info.status === 'recognizing text') {
          console.log('OCR: ' + info.status + ' - ' + Math.round(info.progress * 100) + '%');
        }
      }
    });
    console.log('OCR imagen extraido: ' + (text ? text.length : 0) + ' caracteres');
    return {
      texto: text || '[Imagen sin texto reconocible]',
      paginas: 1,
      metadata: { metodo: 'OCR-imagen' }
    };
  } catch (ocrError) {
    console.error('Error en OCR:', ocrError.message);
    return {
      texto: '[Error al aplicar OCR a imagen: ' + ocrError.message + ']',
      paginas: 1,
      metadata: { error: ocrError.message }
    };
  }
}
    
    // Tipo de archivo no soportado
    return {
      texto: '[Tipo de archivo no soportado para extraccion de texto]',
      paginas: null,
      metadata: { tipoArchivo: mimetype }
    };

  } catch (error) {
    console.error('Error general extrayendo texto:', error);
    return {
      texto: '[Error general: ' + error.message + '. El documento fue guardado pero no se pudo procesar su contenido.]',
      paginas: null,
      metadata: { error: error.message }
    };
  }
}



// FUNCIÓN: Buscar normatividad actualizada (MEJORADA)
async function buscarNormatividadActualizada(consulta) {
  try {
    // Construir consulta más específica
    const consultaEspecifica = `${consulta} site:mineducacion.gov.co OR site:cna.gov.co OR site:cesu.edu.co normatividad Colombia educación superior`;
    
    console.log(`🌐 Consulta en línea: ${consultaEspecifica.substring(0, 80)}...`);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-small-128k-online',
        messages: [
          {
            role: 'system',
            content: `Eres un especialista en normatividad de educación superior en Colombia. 

INSTRUCCIONES OBLIGATORIAS:
1. Busca ÚNICAMENTE en fuentes oficiales: mineducacion.gov.co, cna.gov.co, cesu.edu.co, saces.gov.co
2. Indica SIEMPRE: número exacto de norma, fecha de expedición, artículos relevantes
3. Si encuentras el documento, extrae los puntos clave textuales
4. Proporciona el enlace directo a la norma
5. Si NO encuentras información oficial verificable, decláralo explícitamente

FORMATO DE RESPUESTA:
- Norma identificada: [Número y fecha]
- Fuente oficial: [URL]
- Contenido relevante: [Cita textual de artículos]
- Estado: [Vigente/Derogado]`
          },
          {
            role: 'user',
            content: consultaEspecifica
          }
        ],
        temperature: 0.1,
        max_tokens: 1500,
        return_citations: true,
        search_recency_filter: "month" // Priorizar información reciente
      })
    });

    if (!response.ok) {
      console.log(`⚠️ Perplexity respondió con status ${response.status}`);
      return null;
    }

    const data = await response.json();
    const resultado = data.choices?.[0]?.message?.content || null;
    
    if (resultado) {
      console.log(`✅ Información normativa obtenida (${resultado.length} caracteres)`);
      
      // Extraer citaciones si están disponibles
      const citaciones = data.citations || [];
      if (citaciones.length > 0) {
        const citacionesTexto = '\n\nFUENTES CONSULTADAS:\n' + citaciones.map((c, i) => `${i + 1}. ${c}`).join('\n');
        return resultado + citacionesTexto;
      }
      
      return resultado;
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error en búsqueda normativa:', error.message);
    return null;
  }
}

// FUNCIÓN: Detectar necesidad de búsqueda normativa (MEJORADA)
function necesitaBusquedaNormativa(mensaje) {
  const palabrasClave = [
    'decreto', 'resolución', 'ley', 'lineamiento', 'normatividad', 'vigente', 'actual',
    'cna', 'men', 'cesu', 'conaces', 'saces', 'acuerdo',
    'acreditación', 'registro calificado', 'condiciones de calidad',
    'factor', 'característica', 'aspecto', 'indicador',
    'actualización', 'última versión', 'modificación',
    'artículo', 'capítulo', 'parágrafo', 'literal', 'numeral'
  ];
  
  const mensajeLower = mensaje.toLowerCase();
  
  // 1. Detectar menciones normativas específicas
  const mencionaNormatividad = palabrasClave.some(palabra => mensajeLower.includes(palabra));
  
  // 2. Detectar números de decretos/resoluciones
  const tieneNumeroNormativo = /decreto\s+\d+|resolución\s+\d+|ley\s+\d+|acuerdo\s+\d+/i.test(mensaje);
  
  // 3. Detectar preguntas sobre contenido específico
  const preguntaEspecifica = /qué dice|cuáles son|cómo se|según el|de acuerdo|establece|menciona|indica/i.test(mensaje);
  
  // 4. Detectar preguntas sobre factores CNA
  const preguntaFactoresCNA = /factor\s+\d+|característica\s+\d+|aspecto\s+\d+/i.test(mensaje);
  
  // SIEMPRE buscar en línea si cumple alguna condición
  const debeBuscar = mencionaNormatividad || tieneNumeroNormativo || preguntaEspecifica || preguntaFactoresCNA;
  
  if (debeBuscar) {
    console.log('✅ Se detectó necesidad de búsqueda normativa en línea');
  }
  
  return debeBuscar;
}


// RUTA: Subir documento al repositorio normativo
app.post('/api/repositorio/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }

    const { tipoDocumento, descripcion, categoria, esNormativo } = req.body;

    console.log('📚 Procesando documento para repositorio:', req.file.originalname);

    // Extraer texto del documento
    const extraccion = await extraerTextoDeArchivo(req.file.path, req.file.mimetype);

if (!extraccion) {
  await fs.unlink(req.file.path);
  return res.status(500).json({ error: 'Error crítico al procesar el archivo' });
}

// Permitir documentos aunque no se extraiga texto completo
if (!extraccion.texto || extraccion.texto.length < 10) {
  console.log('⚠️ Documento sin texto extraíble, guardando con metadata');
  extraccion.texto = `[Documento ${req.file.originalname} cargado sin texto extraíble. Tipo: ${req.file.mimetype}]`;
}


    // Analizar documento con IA
    console.log('🔍 Analizando contenido con IA...');
    const analisisIA = await analizarDocumentoConIA(
      extraccion.texto, 
      req.file.originalname,
      tipoDocumento
    );

    // Guardar en colección de repositorio normativo
    if (db) {
      const documento = {
        nombreArchivo: req.file.originalname,
        tipoArchivo: req.file.mimetype,
        tipoDocumento: tipoDocumento || 'General',
        categoria: categoria || 'Sin categoría',
        esNormativo: esNormativo === 'true',
        descripcion: descripcion || '',
        contenido: extraccion.texto,
        analisisIA: analisisIA,
        caracteresExtraidos: extraccion.texto.length,
        paginas: extraccion.paginas,
        metadata: extraccion.metadata,
        fechaCarga: new Date(),
        activo: true
      };

      const resultado = await db.collection('repositorio_normativo').insertOne(documento);

      await fs.unlink(req.file.path);

      res.json({
        mensaje: 'Documento agregado al repositorio exitosamente',
        documentoId: resultado.insertedId,
        nombreArchivo: req.file.originalname,
        caracteresExtraidos: extraccion.texto.length,
        paginas: extraccion.paginas,
        analisisIA: analisisIA,
        tipoDocumento: tipoDocumento
      });
    }

  } catch (error) {
    console.error('❌ Error procesando documento:', error);
    if (req.file && req.file.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: 'Error procesando documento', detalle: error.message });
  }
});

// RUTA: Listar documentos del repositorio
app.get('/api/repositorio/list', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const { categoria, esNormativo } = req.query;
    
    let filtro = { activo: true };
    if (categoria) filtro.categoria = categoria;
    if (esNormativo) filtro.esNormativo = esNormativo === 'true';

    const documentos = await db.collection('repositorio_normativo')
      .find(filtro)
      .sort({ fechaCarga: -1 })
      .project({ contenido: 0 }) // No devolver contenido completo en listado
      .toArray();

    res.json({ 
      documentos,
      total: documentos.length 
    });
  } catch (error) {
    console.error('❌ Error listando repositorio:', error);
    res.status(500).json({ error: 'Error listando repositorio' });
  }
});

// RUTA: Obtener documento específico del repositorio
app.get('/api/repositorio/:documentoId', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const documento = await db.collection('repositorio_normativo')
      .findOne({ _id: new ObjectId(req.params.documentoId) });

    if (!documento) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    res.json({ documento });
  } catch (error) {
    console.error('❌ Error obteniendo documento:', error);
    res.status(500).json({ error: 'Error obteniendo documento' });
  }
});

// RUTA: Actualizar documento en repositorio
app.put('/api/repositorio/:documentoId', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const { descripcion, categoria, activo } = req.body;

    const actualizacion = {};
    if (descripcion !== undefined) actualizacion.descripcion = descripcion;
    if (categoria !== undefined) actualizacion.categoria = categoria;
    if (activo !== undefined) actualizacion.activo = activo;
    actualizacion.fechaActualizacion = new Date();

    const resultado = await db.collection('repositorio_normativo').updateOne(
      { _id: new ObjectId(req.params.documentoId) },
      { $set: actualizacion }
    );

    res.json({ 
      mensaje: 'Documento actualizado',
      modificado: resultado.modifiedCount > 0
    });
  } catch (error) {
    console.error('❌ Error actualizando documento:', error);
    res.status(500).json({ error: 'Error actualizando documento' });
  }
});

// RUTA: Eliminar documento del repositorio
app.delete('/api/repositorio/:documentoId', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    // Marcamos como inactivo en lugar de eliminar físicamente
    const resultado = await db.collection('repositorio_normativo').updateOne(
      { _id: new ObjectId(req.params.documentoId) },
      { $set: { activo: false, fechaEliminacion: new Date() } }
    );

    res.json({ 
      mensaje: 'Documento marcado como inactivo',
      modificado: resultado.modifiedCount > 0
    });
  } catch (error) {
    console.error('❌ Error eliminando documento:', error);
    res.status(500).json({ error: 'Error eliminando documento' });
  }
});

// RUTA: Subir evidencia del usuario
app.post('/api/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }

    const { userId, conversationId, tipoEvidencia, factor, caracteristica } = req.body;
    const userIdFinal = userId || conversationId || Date.now().toString();

    console.log('📄 Procesando evidencia de usuario:', req.file.originalname);

    const extraccion = await extraerTextoDeArchivo(req.file.path, req.file.mimetype);

    if (!extraccion || !extraccion.texto) {
      await fs.unlink(req.file.path);
      return res.status(500).json({ error: 'No se pudo extraer texto del documento' });
    }

    // Analizar evidencia con IA
    const analisisIA = await analizarDocumentoConIA(
      extraccion.texto,
      req.file.originalname,
      tipoEvidencia
    );

    if (db) {
      await db.collection('evidencias').insertOne({
        userId: userIdFinal,
        nombreArchivo: req.file.originalname,
        tipoArchivo: req.file.mimetype,
        tipoEvidencia: tipoEvidencia || 'general',
        factor: factor || null,
        caracteristica: caracteristica || null,
        contenido: extraccion.texto,
        analisisIA: analisisIA,
        caracteresExtraidos: extraccion.texto.length,
        paginas: extraccion.paginas,
        timestamp: new Date()
      });
    }

    await fs.unlink(req.file.path);

    res.json({
      mensaje: 'Evidencia procesada exitosamente',
      nombreArchivo: req.file.originalname,
      caracteresExtraidos: extraccion.texto.length,
      analisisIA: analisisIA,
      tipoEvidencia: tipoEvidencia || 'general'
    });

  } catch (error) {
    console.error('❌ Error procesando evidencia:', error);
    if (req.file && req.file.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: 'Error procesando evidencia', detalle: error.message });
  }
});


// FUNCIÓN: Buscar información específica en documentos del repositorio
async function buscarEnDocumentosRepositorio(pregunta, documentos) {
  try {
    if (!documentos || documentos.length === 0) {
      return { encontrado: false, contexto: '' };
    }

    console.log(`🔍 Buscando información relevante en ${documentos.length} documentos...`);

    // Extraer palabras clave de la pregunta
    const palabrasClave = extraerPalabrasClave(pregunta);
    console.log(`📌 Palabras clave identificadas: ${palabrasClave.join(', ')}`);

    let contextoEncontrado = '';
    let documentosRelevantes = 0;

    for (const doc of documentos) {
      // Buscar secciones relevantes en el contenido
      const seccionesRelevantes = buscarSeccionesRelevantes(doc.contenido, palabrasClave);
      
      if (seccionesRelevantes.length > 0) {
        documentosRelevantes++;
        contextoEncontrado += `\n\n═══ ${doc.nombreArchivo} (${doc.tipoDocumento}) ═══\n`;
        contextoEncontrado += `Categoría: ${doc.categoria} | Normativo: ${doc.esNormativo ? 'Sí' : 'No'}\n\n`;
        
        seccionesRelevantes.forEach((seccion, idx) => {
          contextoEncontrado += `[SECCIÓN RELEVANTE ${idx + 1}]\n${seccion}\n\n`;
        });
      }
    }

    if (documentosRelevantes > 0) {
      console.log(`✅ Información encontrada en ${documentosRelevantes} documento(s)`);
      return { encontrado: true, contexto: contextoEncontrado };
    } else {
      console.log(`⚠️ No se encontró información específica en los documentos`);
      return { encontrado: false, contexto: '' };
    }

  } catch (error) {
    console.error('❌ Error buscando en documentos:', error.message);
    return { encontrado: false, contexto: '' };
  }
}

// FUNCIÓN: Extraer palabras clave de la pregunta
function extraerPalabrasClave(texto) {
  // Remover palabras comunes
  const palabrasComunes = ['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'por', 'para', 'con', 'que', 'qué', 'cuál', 'cuáles', 'son', 'es', 'está', 'según', 'sobre'];
  
  const palabras = texto.toLowerCase()
    .replace(/[¿?¡!.,;:]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length > 3 && !palabrasComunes.includes(p));
  
  // Detectar números de decretos, artículos, etc.
  const patrones = texto.match(/decreto\s+\d+|artículo\s+\d+|factor\s+\d+|característica\s+\d+|resolución\s+\d+/gi) || [];
  
  return [...new Set([...palabras, ...patrones])];
}

// FUNCIÓN: Buscar secciones relevantes en el contenido (MEJORADA)
function buscarSeccionesRelevantes(contenido, palabrasClave) {
  const secciones = [];
  
  // 1. BÚSQUEDA POR BLOQUES (párrafos completos)
  const parrafos = contenido.split(/\n\n+/); // Dividir por párrafos
  
  parrafos.forEach((parrafo, idx) => {
    const parrafoLower = parrafo.toLowerCase();
    
    // Contar cuántas palabras clave contiene este párrafo
    const coincidencias = palabrasClave.filter(palabra => 
      parrafoLower.includes(palabra.toLowerCase())
    ).length;
    
    // Si tiene al menos 2 palabras clave o es muy largo y tiene 1
    if (coincidencias >= 2 || (coincidencias >= 1 && parrafo.length > 200)) {
      // Agregar contexto (párrafo anterior y siguiente si existen)
      let contexto = '';
      if (idx > 0) contexto += parrafos[idx - 1] + '\n\n';
      contexto += parrafo;
      if (idx < parrafos.length - 1) contexto += '\n\n' + parrafos[idx + 1];
      
      if (contexto.trim().length > 100) {
        secciones.push({
          texto: contexto.trim(),
          relevancia: coincidencias
        });
      }
    }
  });
  
  // 2. BÚSQUEDA POR TÍTULOS Y ARTÍCULOS
  const lineas = contenido.split('\n');
  for (let i = 0; i < lineas.length; i++) {
    const lineaLower = lineas[i].toLowerCase();
    
    // Detectar títulos importantes (ARTÍCULO, CAPÍTULO, etc.)
    const esTitulo = /^(artículo|capítulo|sección|título|factor|característica)/i.test(lineas[i].trim());
    
    if (esTitulo) {
      const tienePalabraClave = palabrasClave.some(palabra => 
        lineaLower.includes(palabra.toLowerCase())
      );
      
      if (tienePalabraClave) {
        // Extraer el artículo/sección completo (hasta el siguiente título)
        let textoCompleto = lineas[i] + '\n';
        let j = i + 1;
        
        while (j < lineas.length && !/^(artículo|capítulo|sección|título|factor)/i.test(lineas[j].trim())) {
          textoCompleto += lineas[j] + '\n';
          j++;
          if (j - i > 30) break; // Límite de 30 líneas por sección
        }
        
        if (textoCompleto.trim().length > 100) {
          secciones.push({
            texto: textoCompleto.trim(),
            relevancia: 3 // Alta relevancia para títulos
          });
        }
      }
    }
  }
  
  // 3. ORDENAR POR RELEVANCIA y eliminar duplicados
  const seccionesUnicas = [];
  const textosVistos = new Set();
  
  secciones
    .sort((a, b) => b.relevancia - a.relevancia)
    .forEach(seccion => {
      // Usar los primeros 100 caracteres como firma única
      const firma = seccion.texto.substring(0, 100);
      if (!textosVistos.has(firma)) {
        textosVistos.add(firma);
        seccionesUnicas.push(seccion.texto);
      }
    });
  
  // Limitar a las 8 secciones más relevantes
  return seccionesUnicas.slice(0, 8);
}



// RUTA: Chat principal con repositorio normativo
app.post('/api/chat', async (req, res) => {
  try {
    const { mensaje, conversationId, userId, programa, nivelFormacion, tipoProceso } = req.body;

    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    const userIdFinal = userId || conversationId || Date.now().toString();

    // 1. OBTENER DOCUMENTOS DEL REPOSITORIO NORMATIVO
    let repositorioNormativo = '';
    let documentosRepositorio = []; // ✅ DECLARAR FUERA DEL TRY
    
    if (db) {
      try {
        // Cargar documentos del repositorio normativo
        console.log('📚 Consultando repositorio normativo...');
        documentosRepositorio = await db.collection('repositorio_normativo')
          .find({ activo: true })
          .sort({ fechaCarga: -1 })
          .limit(10)
          .toArray();

        console.log(`✅ Documentos encontrados en repositorio: ${documentosRepositorio.length}`);

        if (documentosRepositorio.length > 0) {
          console.log('📄 Documentos cargados:');
          documentosRepositorio.forEach(doc => {
            console.log(`  - ${doc.nombreArchivo} (${doc.tipoDocumento})`);
          });

          repositorioNormativo = '\n\n═══════════════════════════════════════════════════════════════\n';
          repositorioNormativo += '📚 REPOSITORIO NORMATIVO INSTITUCIONAL\n';
          repositorioNormativo += `Total de documentos disponibles: ${documentosRepositorio.length}\n`;
          repositorioNormativo += '═══════════════════════════════════════════════════════════════\n\n';
          
          documentosRepositorio.forEach((doc, index) => {
            repositorioNormativo += `\n[DOCUMENTO ${index + 1}/${documentosRepositorio.length}]\n`;
            repositorioNormativo += `📄 Archivo: ${doc.nombreArchivo}\n`;
            repositorioNormativo += `📋 Tipo: ${doc.tipoDocumento}\n`;
            repositorioNormativo += `📁 Categoría: ${doc.categoria}\n`;
            repositorioNormativo += `⚖️ Normativo: ${doc.esNormativo ? 'Sí' : 'No'}\n`;
            repositorioNormativo += `📅 Fecha de carga: ${new Date(doc.fechaCarga).toLocaleDateString('es-CO')}\n`;
            
            if (doc.descripcion) {
              repositorioNormativo += `📝 Descripción: ${doc.descripcion}\n`;
            }
            
            repositorioNormativo += '\n--- CONTENIDO DEL DOCUMENTO ---\n';
            // Incluir más contenido del documento (hasta 8000 caracteres)
            const contenidoCompleto = doc.contenido.substring(0, 8000);
            repositorioNormativo += contenidoCompleto + (doc.contenido.length > 8000 ? '...\n' : '\n');
            
            if (doc.analisisIA) {
              repositorioNormativo += '\n--- ANÁLISIS IA DEL DOCUMENTO ---\n';
              repositorioNormativo += doc.analisisIA.substring(0, 5000) + (doc.analisisIA.length > 5000 ? '...\n' : '\n');
            }
            
            repositorioNormativo += '\n' + '─'.repeat(60) + '\n';
          });
          
          console.log(`📊 Contexto del repositorio construido: ${repositorioNormativo.length} caracteres`);
        } else {
          console.log('⚠️ No se encontraron documentos en el repositorio');
        }

      } catch (error) {
        console.log('⚠️ Error cargando repositorio:', error.message);
      }
    }

    // 2. BÚSQUEDA INTELIGENTE EN DOCUMENTOS
    let contextoEspecifico = '';
    if (documentosRepositorio.length > 0) {
      const resultadoBusqueda = await buscarEnDocumentosRepositorio(mensaje, documentosRepositorio);
      
      if (resultadoBusqueda.encontrado) {
        contextoEspecifico = '\n\n═══════════════════════════════════════════════════════════════\n';
        contextoEspecifico += '🎯 INFORMACIÓN ESPECÍFICA ENCONTRADA EN REPOSITORIO\n';
        contextoEspecifico += '═══════════════════════════════════════════════════════════════\n';
        contextoEspecifico += resultadoBusqueda.contexto;
        console.log(`📌 Contexto específico construido: ${contextoEspecifico.length} caracteres`);
      }
    }

    // 3. OBTENER EVIDENCIAS DEL USUARIO
    let evidenciasUsuario = '';
    if (db) {
      try {
        const docs = await db.collection('evidencias')
          .find({ userId: userIdFinal })
          .sort({ timestamp: -1 })
          .limit(3)
          .toArray();

        if (docs.length > 0) {
          evidenciasUsuario = '\n\n=== EVIDENCIAS DEL USUARIO ===\n';
          docs.forEach((doc, index) => {
            evidenciasUsuario += `\n[Evidencia ${index + 1}]\n`;
            evidenciasUsuario += `Archivo: ${doc.nombreArchivo}\n`;
            if (doc.analisisIA) evidenciasUsuario += `Análisis: ${doc.analisisIA}\n`;
            evidenciasUsuario += `Contenido: ${doc.contenido.substring(0, 2000)}...\n`;
          });
        }
      } catch (error) {
        console.log('⚠️ Error cargando evidencias:', error.message);
      }
    }

    // 4. BÚSQUEDA NORMATIVA EN LÍNEA (si es necesario)
    const usarBusquedaNormativa = necesitaBusquedaNormativa(mensaje);
    let informacionNormativa = null;

    if (usarBusquedaNormativa && process.env.PERPLEXITY_API_KEY) {
      console.log('🔍 Buscando normatividad actualizada en línea...');
      informacionNormativa = await buscarNormatividadActualizada(mensaje);
    }

    // 5. OBTENER HISTORIAL
    let mensajesContexto = [];
    if (db) {
      try {
        const historialReciente = await db.collection('conversaciones')
          .find({ 
            $or: [
              { conversationId: userIdFinal },
              { userId: userIdFinal }
            ]
          })
          .sort({ timestamp: -1 })
          .limit(5)
          .toArray();

        historialReciente.reverse().forEach(conv => {
          mensajesContexto.push({
            role: 'user',
            content: conv.mensaje
          });
          mensajesContexto.push({
            role: 'assistant',
            content: conv.respuesta
          });
        });
      } catch (error) {
        console.log('⚠️ No se pudo cargar historial:', error.message);
      }
    }

    // 6. CONSTRUIR CONTEXTO COMPLETO
    let contextoSistema = instruccionesAcademicas;

    contextoSistema += `\n\nCONTEXTO INSTITUCIONAL:
Propósito: ${contextoInstitucional.proposito}
Enfoque: ${contextoInstitucional.enfoque}
Orientación: ${contextoInstitucional.orientacion}`;

    if (programa) contextoSistema += `\n\nPrograma: ${programa}`;
    if (nivelFormacion) contextoSistema += `\nNivel: ${nivelFormacion}`;
    if (tipoProceso) contextoSistema += `\nProceso: ${tipoProceso}`;

    // ✅ AGREGAR CONTEXTO ESPECÍFICO PRIMERO (tiene prioridad)
    if (contextoEspecifico) {
      contextoSistema += contextoEspecifico;
    }

    if (repositorioNormativo) {
      contextoSistema += repositorioNormativo;
    }

    if (evidenciasUsuario) {
      contextoSistema += evidenciasUsuario;
    }

    if (informacionNormativa) {
      contextoSistema += `\n\n=== NORMATIVIDAD VERIFICADA EN LÍNEA ===\n[Requiere validación en fuente primaria]\n${informacionNormativa}\n`;
    }

    // 7. CONSTRUIR MENSAJES
    const mensajesCompletos = [
      {
        role: 'system',
        content: contextoSistema
      },
      ...mensajesContexto,
      {
        role: 'user',
        content: `PREGUNTA DEL USUARIO: ${mensaje}

INSTRUCCIONES ESPECIALES:
- Si el repositorio contiene documentos relacionados con la pregunta, LEE su CONTENIDO COMPLETO (sección "CONTENIDO DEL DOCUMENTO")
- PRIORIZA la sección "INFORMACIÓN ESPECÍFICA ENCONTRADA EN REPOSITORIO" si está disponible
- NO te bases únicamente en el análisis preliminar
- Cita siempre el nombre exacto del documento cuando uses información del repositorio
- Si necesitas más detalles, solicita verificación adicional pero proporciona primero lo que encuentres en el repositorio`
      }
    ];

    // 8. LLAMAR A GROQ
    const chatCompletion = await groq.chat.completions.create({
      messages: mensajesCompletos,
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 2048
    });

    const respuesta = chatCompletion.choices[0].message.content;

    // 9. GUARDAR CONVERSACIÓN
    if (db) {
      await db.collection('conversaciones').insertOne({
        conversationId: userIdFinal,
        userId: userIdFinal,
        mensaje: mensaje,
        respuesta: respuesta,
        programa: programa || null,
        nivelFormacion: nivelFormacion || null,
        tipoProceso: tipoProceso || null,
        timestamp: new Date(),
        modelo: 'llama-3.1-8b-instant',
        repositorioUsado: repositorioNormativo.length > 0,
        evidenciasUsadas: evidenciasUsuario.length > 0,
        busquedaNormativaUsada: informacionNormativa !== null
      });
    }

    // 10. RESPUESTA
    res.json({
      respuesta: respuesta,
      conversationId: userIdFinal,
      repositorioUsado: repositorioNormativo.length > 0,
      evidenciasUsadas: evidenciasUsuario.length > 0,
      busquedaNormativa: informacionNormativa !== null
    });

  } catch (error) {
    console.error('❌ Error en /api/chat:', error);
    res.status(500).json({ 
      error: 'Error procesando consulta',
      detalle: error.message 
    });
  }
});

// Rutas adicionales (health, historial, etc.) - mantener las anteriores


// ========== RUTAS DE BÚSQUEDA AVANZADA ==========

// RUTA: Búsqueda en repositorio normativo
app.get('/api/buscar/repositorio', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const { query, tipoDocumento, categoria, esNormativo, fechaDesde, fechaHasta } = req.query;

    if (!query || query.trim().length < 3) {
      return res.status(400).json({ error: 'La búsqueda debe tener al menos 3 caracteres' });
    }

    // Construir filtro de búsqueda
    let filtro = {
      activo: true,
      $or: [
        { nombreArchivo: { $regex: query, $options: 'i' } },
        { contenido: { $regex: query, $options: 'i' } },
        { analisisIA: { $regex: query, $options: 'i' } },
        { descripcion: { $regex: query, $options: 'i' } }
      ]
    };

    // Filtros adicionales
    if (tipoDocumento) filtro.tipoDocumento = tipoDocumento;
    if (categoria) filtro.categoria = categoria;
    if (esNormativo) filtro.esNormativo = esNormativo === 'true';

    if (fechaDesde || fechaHasta) {
      filtro.fechaCarga = {};
      if (fechaDesde) filtro.fechaCarga.$gte = new Date(fechaDesde);
      if (fechaHasta) filtro.fechaCarga.$lte = new Date(fechaHasta);
    }

    const resultados = await db.collection('repositorio_normativo')
      .find(filtro)
      .sort({ fechaCarga: -1 })
      .limit(50)
      .toArray();

    res.json({
      query: query,
      resultados: resultados,
      total: resultados.length,
      fuente: 'repositorio_normativo'
    });

  } catch (error) {
    console.error('❌ Error en búsqueda repositorio:', error);
    res.status(500).json({ error: 'Error en búsqueda', detalle: error.message });
  }
});

// RUTA: Búsqueda en conversaciones
app.get('/api/buscar/conversaciones', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const { query, userId, programa, fechaDesde, fechaHasta } = req.query;

    if (!query || query.trim().length < 3) {
      return res.status(400).json({ error: 'La búsqueda debe tener al menos 3 caracteres' });
    }

    let filtro = {
      $or: [
        { mensaje: { $regex: query, $options: 'i' } },
        { respuesta: { $regex: query, $options: 'i' } }
      ]
    };

    if (userId) filtro.userId = userId;
    if (programa) filtro.programa = { $regex: programa, $options: 'i' };

    if (fechaDesde || fechaHasta) {
      filtro.timestamp = {};
      if (fechaDesde) filtro.timestamp.$gte = new Date(fechaDesde);
      if (fechaHasta) filtro.timestamp.$lte = new Date(fechaHasta);
    }

    const resultados = await db.collection('conversaciones')
      .find(filtro)
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();

    res.json({
      query: query,
      resultados: resultados,
      total: resultados.length,
      fuente: 'conversaciones'
    });

  } catch (error) {
    console.error('❌ Error en búsqueda conversaciones:', error);
    res.status(500).json({ error: 'Error en búsqueda', detalle: error.message });
  }
});

// RUTA: Búsqueda en evidencias
app.get('/api/buscar/evidencias', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const { query, userId, tipoEvidencia } = req.query;

    if (!query || query.trim().length < 3) {
      return res.status(400).json({ error: 'La búsqueda debe tener al menos 3 caracteres' });
    }

    let filtro = {
      $or: [
        { nombreArchivo: { $regex: query, $options: 'i' } },
        { contenido: { $regex: query, $options: 'i' } },
        { analisisIA: { $regex: query, $options: 'i' } }
      ]
    };

    if (userId) filtro.userId = userId;
    if (tipoEvidencia) filtro.tipoEvidencia = tipoEvidencia;

    const resultados = await db.collection('evidencias')
      .find(filtro)
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();

    res.json({
      query: query,
      resultados: resultados,
      total: resultados.length,
      fuente: 'evidencias'
    });

  } catch (error) {
    console.error('❌ Error en búsqueda evidencias:', error);
    res.status(500).json({ error: 'Error en búsqueda', detalle: error.message });
  }
});

// RUTA: Búsqueda GLOBAL (en todas las colecciones)
app.get('/api/buscar/global', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const { query } = req.query;

    if (!query || query.trim().length < 3) {
      return res.status(400).json({ error: 'La búsqueda debe tener al menos 3 caracteres' });
    }

    // Búsqueda en paralelo en todas las colecciones
    const [repositorio, conversaciones, evidencias] = await Promise.all([
      db.collection('repositorio_normativo').find({
        activo: true,
        $or: [
          { nombreArchivo: { $regex: query, $options: 'i' } },
          { contenido: { $regex: query, $options: 'i' } },
          { analisisIA: { $regex: query, $options: 'i' } }
        ]
      }).limit(20).toArray(),

      db.collection('conversaciones').find({
        $or: [
          { mensaje: { $regex: query, $options: 'i' } },
          { respuesta: { $regex: query, $options: 'i' } }
        ]
      }).limit(20).toArray(),

      db.collection('evidencias').find({
        $or: [
          { nombreArchivo: { $regex: query, $options: 'i' } },
          { contenido: { $regex: query, $options: 'i' } },
          { analisisIA: { $regex: query, $options: 'i' } }
        ]
      }).limit(20).toArray()
    ]);

    res.json({
      query: query,
      resultados: {
        repositorio: repositorio,
        conversaciones: conversaciones,
        evidencias: evidencias
      },
      totales: {
        repositorio: repositorio.length,
        conversaciones: conversaciones.length,
        evidencias: evidencias.length,
        total: repositorio.length + conversaciones.length + evidencias.length
      }
    });

  } catch (error) {
    console.error('❌ Error en búsqueda global:', error);
    res.status(500).json({ error: 'Error en búsqueda global', detalle: error.message });
  }
});

// RUTA: Exportar resultados de búsqueda a JSON
app.post('/api/exportar/busqueda', async (req, res) => {
  try {
    const { resultados, query, fuente } = req.body;

    if (!resultados || resultados.length === 0) {
      return res.status(400).json({ error: 'No hay resultados para exportar' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="busqueda_${fuente}_${Date.now()}.json"`);
    
    res.json({
      busqueda: query,
      fuente: fuente,
      fecha_exportacion: new Date().toISOString(),
      total_resultados: resultados.length,
      resultados: resultados
    });

  } catch (error) {
    console.error('❌ Error exportando:', error);
    res.status(500).json({ error: 'Error en exportación' });
  }
});




app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    sistema: 'Asistente Virtual Autoevaluación Académica',
    version: '2.0',
    mongodb: db ? 'conectado' : 'desconectado',
    groq: process.env.GROQ_API_KEY ? 'configurado' : 'no configurado',
    perplexity: process.env.PERPLEXITY_API_KEY ? 'configurado' : 'no configurado',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    sistema: 'Asistente Virtual - Autoevaluación Académica',
    version: '2.0',
    funcionalidades: [
      'Repositorio normativo institucional',
      'Análisis mejorado de documentos con IA',
      'Validación normativa en línea',
      'Gestión de evidencias',
      'Sistema de etiquetado de certeza'
    ],
    endpoints: {
      chat: 'POST /api/chat',
      uploadEvidencia: 'POST /api/upload',
      repositorioUpload: 'POST /api/repositorio/upload',
      repositorioList: 'GET /api/repositorio/list',
      repositorioGet: 'GET /api/repositorio/:id',
      repositorioUpdate: 'PUT /api/repositorio/:id',
      repositorioDelete: 'DELETE /api/repositorio/:id'
    }
  });
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Error no manejado:', error);
});

async function iniciarServidor() {
  await connectDB();
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(80));
    console.log('🎓 SISTEMA DE AUTOEVALUACIÓN ACADÉMICA v2.0');
    console.log('='.repeat(80));
    console.log('🚀 Servidor: http://localhost:' + PORT);
    console.log('📡 API Chat: http://localhost:' + PORT + '/api/chat');
    console.log('📚 Repositorio Normativo: ✅ ACTIVO');
    console.log('🔍 Análisis IA mejorado: ✅ ACTIVO');
    console.log('🌐 Validación normativa en línea: ' + (process.env.PERPLEXITY_API_KEY ? '✅ ACTIVA' : '❌ INACTIVA'));
    console.log('💾 MongoDB: ' + (db ? '✅ CONECTADO' : '❌ DESCONECTADO'));
    console.log('='.repeat(80) + '\n');
  });
}

iniciarServidor();
