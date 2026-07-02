// backend/server.js
// Entry point: starts the Express HTTP server and attaches a WebSocket
// server that handles the live incoming-call audio pipeline.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fetch = require('node-fetch');

const config = require('../config/config');
const logger = require('./logger');
const { attachWebSocketHandlers } = require('./websocket');
const db = require('../database/sqlite'); // eslint-disable-line no-unused-vars (initializes schema)

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Health check ----
app.get('/health', (req, res) => {
  res.json({ status: 'ok', provider: config.ai.provider, sttEngine: config.stt.engine, ttsEngine: config.tts.engine });
});

// ---- Twilio Webhook (returns TwiML XML stream instruction) ----
app.all(['/twilio/voice', '/api/twilio/voice'], (req, res) => {
  const host = req.get('host') || `localhost:${config.port}`;
  const protocol = req.headers['x-forwarded-proto'] === 'https' || host.includes('ngrok') ? 'wss' : 'ws';
  const streamUrl = `${protocol}://${host}${config.ws.path}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  logger.info(`Serving Twilio TwiML stream endpoint linking to ${streamUrl}`);
  res.type('text/xml').send(twiml);
});

// ---- Fetch call history (for WebRTC dashboard & logs) ----
app.get('/api/calls', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const calls = db.getAllCalls(limit);
  res.json({ status: 'ok', calls });
});

// ---- Fetch a call transcript ----
app.get(['/calls/:callId/transcript', '/api/calls/:callId/transcript'], (req, res) => {
  const transcript = db.getTranscript(req.params.callId);
  res.json({ callId: req.params.callId, transcript });
});

// ---- Outbound PSTN Dialer Endpoint ----
app.post('/api/twilio/call', async (req, res) => {
  const { to } = req.body;
  if (!to) {
    return res.status(400).json({ status: 'error', message: 'Destination phone number ("to") is required.' });
  }

  const { accountSid, authToken, phoneNumber } = config.twilio;
  if (!accountSid || !authToken) {
    return res.status(400).json({
      status: 'error',
      message: 'Twilio Account SID and Auth Token are not configured in environment variables (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).'
    });
  }

  const host = req.get('host') || `localhost:${config.port}`;
  const protocol = req.headers['x-forwarded-proto'] === 'https' || host.includes('ngrok') || host.includes('onrender.com') ? 'https' : 'http';
  const webhookUrl = `${protocol}://${host}/twilio/voice`;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
  const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const params = new URLSearchParams();
  params.append('To', to);
  params.append('From', phoneNumber);
  params.append('Url', webhookUrl);

  try {
    const twilioRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const data = await twilioRes.json();
    if (!twilioRes.ok) {
      logger.error('Twilio Outbound Call failed', { status: twilioRes.status, error: data });
      return res.status(twilioRes.status).json({ status: 'error', message: data.message || 'Twilio call failed', details: data });
    }

    logger.info(`Outbound call initiated to ${to}`, { callSid: data.sid });
    return res.json({ status: 'ok', message: `Call placed to ${to}`, callSid: data.sid });
  } catch (err) {
    logger.error('Error calling Twilio API', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

const server = http.createServer(app);

// ---- WebSocket server for the live audio/media stream ----
const wss = new WebSocketServer({ server, path: config.ws.path });
attachWebSocketHandlers(wss);

server.listen(config.port, () => {
  logger.info(`Voice bot server listening on port ${config.port}`);
  logger.info(`WebSocket media endpoint: ws://localhost:${config.port}${config.ws.path}`);
  logger.info(`AI provider: ${config.ai.provider} | STT: ${config.stt.engine} | TTS: ${config.tts.engine}`);
});

// ---- Graceful shutdown ----
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  server.close(() => process.exit(0));
});
