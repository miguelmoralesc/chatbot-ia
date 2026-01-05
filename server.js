// Importar librerías necesarias
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const { MongoClient } = require('mongodb');

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

// Ruta principal - Chat con CONTEXTO MEJORADO
app.post('/api/chat', async (req, res) => {
  try {
    const { mensaje, conversationId, userId } = req.body;

    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    const userIdFinal = userId || conversationId || new Date().getTime().toString();

    // 1. OBTENER HISTORIAL RECIENTE (últimas 5 conversaciones del usuario)
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

        // Agregar historial en orden cronológico correcto
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

    // 2. Construir contexto con información personalizada
    const contextoSistema = `Eres un asistente virtual experto en gestión de talleres automotrices.

Información de la empresa:
- Empresa: ${baseConocimiento.empresa}
- Servicios: ${baseConocimiento.servicios.join(', ')}
- Horarios: ${baseConocimiento.horarios}
- Contacto: Tel: ${baseConocimiento.contacto.telefono}, Email: ${baseConocimiento.contacto.email}

Instrucciones:
- Responde de forma amigable y profesional
- Usa la información proporcionada para responder
- Recuerda el contexto de la conversación anterior
- Si no sabes algo, sugiere contactar directamente
- Sé conciso pero informativo`;

    // 3. Construir array de mensajes con contexto completo
    const mensajesCompletos = [
      {
        role: 'system',
        content: contextoSistema
      },
      ...mensajesContexto, // Historial previo
      {
        role: 'user',
        content: mensaje // Mensaje actual
      }
    ];

    // 4. Llamar a Groq API con contexto completo
    const chatCompletion = await groq.chat.completions.create({
      messages: mensajesCompletos,
      model: 'llama-3.1-8b-instant',
      temperature: 0.7,
      max_tokens: 1024
    });

    const respuesta = chatCompletion.choices[0].message.content;

    // 5. Guardar conversación en MongoDB
    if (db) {
      await db.collection('conversaciones').insertOne({
        conversationId: userIdFinal,
        userId: userIdFinal,
        mensaje: mensaje,
        respuesta: respuesta,
        timestamp: new Date(),
        modelo: 'llama-3.1-8b-instant',
        contextoUsado: mensajesContexto.length > 0
      });
    }

    // 6. Enviar respuesta
    res.json({
      respuesta: respuesta,
      conversationId: userIdFinal,
      contextoAplicado: mensajesContexto.length > 0
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

// Ruta para limpiar historial de un usuario
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

// Ruta de salud (health check)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    mongodb: db ? 'conectado' : 'desconectado',
    groq: process.env.GROQ_API_KEY ? 'configurado' : 'no configurado',
    timestamp: new Date().toISOString()
  });
});

// Ruta raíz informativa
app.get('/', (req, res) => {
  res.json({
    servicio: 'Chatbot IA - Taller Automotriz',
    version: '2.0',
    endpoints: {
      chat: 'POST /api/chat',
      historial: 'GET /api/historial/:conversationId',
      limpiar: 'DELETE /api/historial/:conversationId',
      health: 'GET /api/health'
    }
  });
});

// Manejo de errores global
process.on('unhandledRejection', (error) => {
  console.error('❌ Error no manejado:', error);
});

// Iniciar servidor
async function iniciarServidor() {
  await connectDB();
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 Servidor iniciado en http://localhost:' + PORT);
    console.log('📡 API disponible en http://localhost:' + PORT + '/api/chat');
    console.log('🔍 Health check: http://localhost:' + PORT + '/api/health');
    console.log('='.repeat(60) + '\n');
  });
}

iniciarServidor();
