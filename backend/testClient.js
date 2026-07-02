// backend/testClient.js
// A simple CLI test client that simulates an incoming call by streaming a
// local WAV file to the bot's WebSocket endpoint and playing back its
// spoken replies. Useful for testing the full pipeline without a real
// SIP/PBX telephony bridge.
//
// Usage:
//   node backend/testClient.js path/to/your-question.wav
//
// The WAV file should be 16-bit PCM, 16kHz, mono (use ffmpeg to convert):
//   ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 question.wav

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const config = require('../config/config');

const wavFile = process.argv[2];
if (!wavFile) {
  console.error('Usage: node backend/testClient.js path/to/audio.wav');
  process.exit(1);
}

const url = `ws://localhost:${config.port}${config.ws.path}`;
const ws = new WebSocket(url);

function readWavPcmData(filePath) {
  const buffer = fs.readFileSync(filePath);
  // Skip the standard 44-byte WAV header to get raw PCM samples.
  return buffer.slice(44);
}

ws.on('open', () => {
  console.log('Connected to voice bot. Starting simulated call...');
  ws.send(JSON.stringify({ type: 'start_call', callId: `test-${Date.now()}`, callerId: '+91-TESTCALL' }));
});

ws.on('message', (message, isBinary) => {
  if (isBinary) {
    const outPath = path.join(__dirname, '..', `reply-${Date.now()}.wav`);
    fs.writeFileSync(outPath, message);
    console.log(`Bot audio reply saved to: ${outPath}`);
    return;
  }

  const data = JSON.parse(message.toString());
  console.log(`[${data.type}]`, data.text || '');

  if (data.type === 'greeting' || data.type === 'reply') {
    // After the bot finishes speaking, send our simulated caller audio.
    if (fs.existsSync(wavFile)) {
      const pcm = readWavPcmData(wavFile);
      ws.send(pcm, { binary: true });
      ws.send(JSON.stringify({ type: 'utterance_end' }));
    }
  }

  if (data.type === 'call_ended') {
    console.log('Call ended. Closing connection.');
    ws.close();
  }
});

ws.on('close', () => console.log('Disconnected.'));
ws.on('error', (err) => console.error('WebSocket error:', err.message));
