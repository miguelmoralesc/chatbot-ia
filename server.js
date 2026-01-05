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

// Conexión a MongoDB
let db;
const mongoClient = new MongoClient(process.env.MONGODB_URI);

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

// Ruta principal - Chat
app.post('/api/chat', async (req, res) => {
  try {
    const { mensaje, conversationId } = req.body;

    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    // Construir contexto con información personalizada
    const contextoSistema = `Eres un asistente virtual experto en gestión de talleres automotrices.

Información de la empresa:
- Empresa: ${baseConocimiento.empresa}
- Servicios: ${baseConocimiento.servicios.join(', ')}
- Horarios: ${baseConocimiento.horarios}
- Contacto: Tel: ${baseConocimiento.contacto.telefono}, Email: ${baseConocimiento.contacto.email}

Instrucciones:
- Responde de forma amigable y profesional
- Usa la información proporcionada para responder
- Si no sabes algo, sugiere contactar directamente
- Sé conciso pero informativo`;

    // Llamar a Groq API
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: contextoSistema
        },
        {
          role: 'user',
          content: mensaje
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.7,
      max_tokens: 1024
    });

    const respuesta = chatCompletion.choices[0].message.content;

    // Guardar conversación en MongoDB
    if (db) {
      await db.collection('conversaciones').insertOne({
        conversationId: conversationId || new Date().getTime().toString(),
        mensaje: mensaje,
        respuesta: respuesta,
        timestamp: new Date(),
        modelo: 'llama-3.1-8b-instant'
      });
    }

    // Enviar respuesta
    res.json({
      respuesta: respuesta,
      conversationId: conversationId || new Date().getTime().toString()
    });

  } catch (error) {
    console.error('Error en /api/chat:', error);
    res.status(500).json({ 
      error: 'Error procesando mensaje',
      detalle: error.message 
    });
  }
});

// Ruta para obtener historial
app.get('/api/historial/:conversationId', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }

    const historial = await db.collection('conversaciones')
      .find({ conversationId: req.params.conversationId })
      .sort({ timestamp: 1 })
      .toArray();

    res.json({ historial });
  } catch (error) {
    console.error('Error obteniendo historial:', error);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// Ruta de salud (health check)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    mongodb: db ? 'conectado' : 'desconectado',
    groq: process.env.GROQ_API_KEY ? 'configurado' : 'no configurado'
  });
});

// Iniciar servidor
async function iniciarServidor() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`\n🚀 Servidor iniciado en http://localhost:${PORT}`);
    console.log(`📡 API disponible en http://localhost:${PORT}/api/chat`);
    console.log(`🔍 Health check: http://localhost:${PORT}/api/health\n`);
  });
}

iniciarServidor();
