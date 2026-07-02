// config/config.js
// Central place that reads environment variables and exposes a single
// typed configuration object used across the whole application.

require('dotenv').config();
const path = require('path');

function parseApiKeys(pluralVal, singularVal) {
  const keys = [];
  if (pluralVal) {
    String(pluralVal).split(',').forEach(k => {
      const trimmed = k.trim();
      if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
    });
  }
  if (singularVal) {
    String(singularVal).split(',').forEach(k => {
      const trimmed = k.trim();
      if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
    });
  }
  return keys;
}

const geminiKeys = parseApiKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY);
const groqKeys = parseApiKeys(process.env.GROQ_API_KEYS, process.env.GROQ_API_KEY);

const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  ai: {
    provider: (process.env.API_PROVIDER || 'gemini').toLowerCase(), // gemini | groq | auto | all
    gemini: {
      apiKeys: geminiKeys,
      get apiKey() {
        return geminiKeys[0] || '';
      },
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    groq: {
      apiKeys: groqKeys,
      get apiKey() {
        return groqKeys[0] || '';
      },
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    },
  },

  stt: {
    engine: (process.env.STT_ENGINE || 'groq').toLowerCase(), // groq | whispercpp | fasterwhisper
    language: process.env.STT_LANGUAGE || 'hi',
    whisperCpp: {
      bin: process.env.WHISPER_CPP_BIN || './bin/whisper.cpp/main',
      model: process.env.WHISPER_CPP_MODEL || './bin/whisper.cpp/models/ggml-base.bin',
    },
    fasterWhisper: {
      script: process.env.FASTER_WHISPER_SCRIPT || './backend/scripts/faster_whisper_transcribe.py',
      model: process.env.FASTER_WHISPER_MODEL || 'medium',
      device: process.env.FASTER_WHISPER_DEVICE || 'cpu',
    },
  },

  tts: {
    engine: (process.env.TTS_ENGINE || 'edgetts').toLowerCase(), // edgetts | piper | coqui
    edgeVoice: process.env.EDGE_VOICE || 'hi-IN-SwaraNeural',
    piper: {
      bin: process.env.PIPER_BIN || './bin/piper/piper',
      voiceModel: process.env.PIPER_VOICE_MODEL || './bin/piper/voices/hi_IN-pratham-medium.onnx',
    },
    voice: process.env.VOICE || 'hi-IN',
  },

  db: {
    path: process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'database', 'voicebot.db'),
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '+17373383221',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || path.join(__dirname, '..', 'logs', 'calls.log'),
  },

  promptPath: path.join(__dirname, 'prompt.txt'),

  ws: {
    path: process.env.WS_PATH || '/media-stream',
  },
};

module.exports = config;
