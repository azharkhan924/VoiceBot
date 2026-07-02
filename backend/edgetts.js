// backend/edgetts.js
// High-quality, ultra-fast neural Text-to-Speech using Microsoft Edge TTS over WebSocket.
// 100% Free, no API keys required, ~150ms latency, natural Indian accents.

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

const EDGE_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/**
 * Synthesizes speech using Microsoft Edge online neural voices.
 * Default voice: hi-IN-SwaraNeural (Warm, expressive Indian female voice supporting Hindi/Hinglish)
 */
function synthesizeWithEdgeTTS(text, voiceName = 'hi-IN-SwaraNeural', rate = '+10%') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(EDGE_URL, {
      headers: {
        'Origin': 'chrome-extension://jdiccldimpdaibogdichlkgimccdeomabk',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edge/120.0.0.0'
      }
    });

    const audioBuffers = [];
    const reqId = uuidv4().replace(/-/g, '');

    ws.on('open', () => {
      const timestamp = new Date().toString();
      const configMsg = `X-Timestamp: ${timestamp}\r\nContent-Type: application/json; charset=utf-8\r\nPath: speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"riff-16khz-16bit-mono-pcm"}}}}`;
      ws.send(configMsg);

      // Escape XML characters
      const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="hi-IN"><voice name="${voiceName}"><prosody rate="${rate}">${safeText}</prosody></voice></speak>`;
      const ssmlMsg = `X-RequestId: ${reqId}\r\nX-Timestamp: ${timestamp}\r\nContent-Type: application/ssml+xml\r\nPath: ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMsg);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (data.length > 2) {
          const headerLen = data.readUInt16BE(0);
          if (data.length > 2 + headerLen) {
            const audioData = data.slice(2 + headerLen);
            audioBuffers.push(audioData);
          }
        }
      } else {
        const str = data.toString();
        if (str.includes('Path:turn.end')) {
          ws.close();
        }
      }
    });

    ws.on('close', () => {
      const finalWav = Buffer.concat(audioBuffers);
      if (finalWav.length === 0) {
        reject(new Error('Edge TTS returned empty audio'));
      } else {
        resolve(finalWav);
      }
    });

    ws.on('error', (err) => reject(err));
  });
}

module.exports = { synthesizeWithEdgeTTS };
