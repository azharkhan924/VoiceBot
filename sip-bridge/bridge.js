#!/usr/bin/env node
/**
 * sip-bridge/bridge.js
 * EAGI WebSocket bridge connecting Asterisk SIP calls to the live AI Voice Bot.
 */

const fs = require('fs');
const WebSocket = require('ws');

// Get websocket target from arguments or environment
const WS_URL = process.argv[2] || process.env.BOT_WS_URL || 'wss://voicebot-omrc.onrender.com/media-stream';

// Connect to the Voice Bot WebSocket endpoint
const ws = new WebSocket(WS_URL);

let callId = `sip-${Date.now()}`;
let isConnected = false;

// Read AGI headers from stdin
process.stdin.setEncoding('utf8');
let agiHeaders = {};

process.stdin.on('data', (chunk) => {
  const lines = chunk.split('\n');
  for (const line of lines) {
    if (line.includes(':')) {
      const [k, v] = line.split(':');
      agiHeaders[k.trim()] = v.trim();
    }
  }
});

// Helper to send AGI commands to Asterisk over stdout
function sendAgiCommand(cmd) {
  process.stdout.write(`${cmd}\n`);
}

// Upsample 8kHz PCM16 audio from Asterisk to 16kHz for Whisper STT
function upsample8kTo16k(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length - 1; i += 2) {
    const val = buf.readInt16LE(i);
    out.writeInt16LE(val, i * 2);
    out.writeInt16LE(val, i * 2 + 2);
  }
  return out;
}

ws.on('open', () => {
  isConnected = true;
  const callerId = agiHeaders['agi_callerid'] || 'SIP-Caller';
  ws.send(JSON.stringify({ type: 'start_call', callId, callerId }));

  // EAGI opens File Descriptor 3 for raw audio stream coming from the caller
  const audioStream = fs.createReadStream('', { fd: 3 });
  audioStream.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      // Convert 8kHz Slin to 16kHz PCM
      const resampled = upsample8kTo16k(chunk);
      ws.send(resampled);
    }
  });

  audioStream.on('error', () => {
    process.exit(0);
  });
});

// Receive AI voice responses from the WebSocket and play them back via Asterisk
let counter = 0;
ws.on('message', async (data) => {
  if (data instanceof Buffer || data instanceof ArrayBuffer) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const tmpPath = `/tmp/ai_reply_${callId}_${counter++}.wav`;
    fs.writeFileSync(tmpPath, buf);

    // Tell Asterisk to play the audio file (without .wav extension)
    const playPath = tmpPath.replace(/\.wav$/, '');
    sendAgiCommand(`STREAM FILE ${playPath} ""`);
  }
});

ws.on('close', () => {
  sendAgiCommand('HANGUP');
  process.exit(0);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
