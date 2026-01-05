// Importar librerías necesarias
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch'); // Para llamar a Perplexity API

// Configuración
const app = express();
const PORT = process.env.PORT || 3000;

// Inicializar cliente de Groq
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Conexión a MongoDB con configuración optimizada
let db;
const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://miguelmorales1428_db_user:Qo6JHRT9O0Nf3BKk@cluster0.g1o7k7a.mongodb.net/chatbot_database?retryWrites=true&w=majority&ssl=true&authSource=admin';

const mongoClient = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

async function connectDB() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('chatbot_database');
    console.log('✅ Conectado a MongoDB Atlas');
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Base de conocimientos personalizada
const baseConocimiento = {
  empresa: "Taller Automotriz - Sistema de gestión de servicios",
  servicios: [
    "Mantenimiento preventivo y correctivo",
    "Reparación de motores",
    "Diagnóstico electrónico",
    "Alineación y balanceo",
    "Cambio de aceite y filtros",
    "Sistema de frenos"
  ],
  horarios: "Lunes a viernes: 8:00 AM - 6:00 PM, Sábados: 9:00 AM - 2:00 PM",
  contacto: {
    telefono: "+57 300 123 4567",
    email: "contacto@taller.com",
    direccion: "Bogotá, Colombia"
  }
};

// FUNCIÓN: Detectar si necesita búsqueda web
function necesitaBusquedaWeb(mensaje) {
  const palabrasClave = [
    'precio', 'costo', 'cuánto cuesta', 'valor',
    'actual', 'hoy', 'reciente', 'último', 'nueva',
    'noticias', 'información sobre', 'qué es',
    'busca', 'investiga', 'encuentra'
  ];
  
  const mensajeLower = mensaje.toLowerCase();
  return palabrasClave.some(palabra => mensajeLower.includes(palabra));
}

// FUNCIÓN: Buscar en web con Perplexity
async function buscarEnWeb(query) {
  try {
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
            content: 'Eres un asistente que busca información actualizada en internet. Responde de forma concisa y precisa.'
          },
          {
            role: 'user',
            content: query
          }
        ],
        temperature: 0.2,
        max_tokens: 500
      })
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error('❌ Error en búsqueda web:', error);
    return null;
  }
}

// Ruta principal - Chat con CONTEXTO Y BÚSQUEDA WEB
app.post('/api/chat', async (req, res) => {
  try {
    const { mensaje, conversationId, userId } = req.body;

    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    const userIdFinal = userId || conversationId || new Date().getTime().toString();

    // 1. DETECTAR SI NECESITA BÚSQUEDA WEB
    const usarBusquedaWeb = necesitaBusquedaWeb(mensaje);
    let informacionWeb = null;

    if (usarBusquedaWeb && process.env.PERPLEXITY_API_KEY) {
      console.log('🔍 Realizando búsqueda web para:', mensaje);
      informacionWeb = await buscarEnWeb(mensaje);
    }

    // 2. OBTENER HISTORIAL RECIENTE
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

    // 3. CONSTRUIR CONTEXTO CON INFORMACIÓN WEB (SI EXISTE)
    let contextoSistema = `Eres un asistente virtual experto en gestión de talleres automotrices.

Información de la empresa:
- Empresa: ${baseConocimiento.empresa}
- Servicios: ${baseConocimiento.servicios.join(', ')}
- Horarios: ${baseConocimiento.horarios}
- Contacto: Tel: ${baseConocimiento.contacto.telefono}, Email: ${baseConocimiento.contacto.email}`;

    if (informacionWeb) {
      contextoSistema += `\n\nINFORMACIÓN ACTUALIZADA DE INTERNET:\n${informacionWeb}`;
    }

    contextoSistema += `\n\nInstrucciones:
- Responde de forma amigable y profesional
- Usa la información proporcionada para responder
- Si hay información actualizada de internet, úsala en tu respuesta
- Recuerda el contexto de la conversación anterior
- Si no sabes algo, sugiere contactar directamente
- Sé conciso pero informativo`;

    // 4. CONSTRUIR MENSAJES COMPLETOS
    const mensajesCompletos = [
      {
        role: 'system',
        content: contextoSistema
      },
      ...mensajesContexto,
      {
        role: 'user',
        content: mensaje
      }
    ];

    // 5. LLAMAR A GROQ API
    const chatCompletion = await groq.chat.completions.create({
      messages: mensajesCompletos,
      model: 'llama-3.1-8b-instant',
      temperature: 0.7,
      max_tokens: 1024
    });

    const respuesta = chatCompletion.choices[0].message.content;

    // 6. GUARDAR EN MONGODB
    if (db) {
      await db.collection('conversaciones').insertOne({
        conversationId: userIdFinal,
        userId: userIdFinal,
        mensaje: mensaje,
        respuesta: respuesta,
        timestamp: new Date(),
        modelo: 'llama-3.1-8b-instant',
        contextoUsado: mensajesContexto.length > 0,
        busquedaWebUsada: informacionWeb !== null
      });
    }

    // 7. ENVIAR RESPUESTA
    res.json({
      respuesta: respuesta,
      conversationId: userIdFinal,
      contextoAplicado: mensajesContexto.length > 0,
      busquedaWeb: informacionWeb !== null
    });

  } catch (error) {
    console.error('❌ Error en /api/chat:', error);
    res.status(500).json({ 
      error: 'Error procesando mensaje',
      detalle: error.message 
    });
  }
});

// Ruta para obtener historial completo
app.get('/api/historial/:conversationId', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const historial = await db.collection('conversaciones')
      .find({ 
        $or: [
          { conversationId: req.params.conversationId },
          { userId: req.params.conversationId }
        ]
      })
      .sort({ timestamp: 1 })
      .toArray();

    res.json({ 
      historial,
      total: historial.length 
    });
  } catch (error) {
    console.error('❌ Error obteniendo historial:', error);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// Ruta para limpiar historial
app.delete('/api/historial/:conversationId', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const resultado = await db.collection('conversaciones').deleteMany({
      $or: [
        { conversationId: req.params.conversationId },
        { userId: req.params.conversationId }
      ]
    });

    res.json({ 
      mensaje: 'Historial eliminado',
      eliminados: resultado.deletedCount 
    });
  } catch (error) {
    console.error('❌ Error eliminando historial:', error);
    res.status(500).json({ error: 'Error eliminando historial' });
  }
});

// Ruta de salud
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    mongodb: db ? 'conectado' : 'desconectado',
    groq: process.env.GROQ_API_KEY ? 'configurado' : 'no configurado',
    perplexity: process.env.PERPLEXITY_API_KEY ? 'configurado' : 'no configurado',
    timestamp: new Date().toISOString()
  });
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({
    servicio: 'Chatbot IA - Taller Automotriz',
    version: '3.0',
    funcionalidades: [
      'Contexto entre conversaciones',
      'Búsqueda web en tiempo real',
      'Historial persistente'
    ],
    endpoints: {
      chat: 'POST /api/chat',
      historial: 'GET /api/historial/:conversationId',
      limpiar: 'DELETE /api/historial/:conversationId',
      health: 'GET /api/health'
    }
  });
});

// Manejo de errores
process.on('unhandledRejection', (error) => {
  console.error('❌ Error no manejado:', error);
});

// Iniciar servidor
async function iniciarServidor() {
  await connectDB();
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 Servidor iniciado en http://localhost:' + PORT);
    console.log('📡 API Chat: http://localhost:' + PORT + '/api/chat');
    console.log('🔍 Búsqueda web: ' + (process.env.PERPLEXITY_API_KEY ? '✅ ACTIVA' : '❌ INACTIVA'));
    console.log('💾 MongoDB: ' + (db ? '✅ CONECTADO' : '❌ DESCONECTADO'));
    console.log('='.repeat(60) + '\n');
  });
}

iniciarServidor();
