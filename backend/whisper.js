// backend/whisper.js
// Speech-to-Text wrapper. Supports two fully free/offline engines:
//   1. whisper.cpp   - fast C++ inference, great for low-latency streaming
//   2. faster-whisper (Python, CTranslate2) - easy to set up, good accuracy
//
// Both engines are invoked as child processes on WAV audio chunks and
// support Hindi / English / Hinglish via language='hi' (Whisper handles
// code-switching reasonably well when hinted with Hindi).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');
const config = require('../config/config');
const logger = require('./logger');

let groqSttKeyIndex = 0;

/**
 * Transcribes audio online using Groq's free Whisper Large V3 API.
 * High accuracy (1.5B parameters), <200ms speed, 0MB server CPU usage.
 */
async function transcribeWithGroq(wavPath) {
  const apiKeys = config.ai.groq.apiKeys && config.ai.groq.apiKeys.length > 0
    ? config.ai.groq.apiKeys
    : (config.ai.groq.apiKey ? [config.ai.groq.apiKey] : []);

  if (!apiKeys.length) {
    throw new Error('GROQ_API_KEYS is not set for Groq Whisper STT');
  }

  const fileData = fs.readFileSync(wavPath);
  const fileName = path.basename(wavPath);

  let lastError = null;
  const startIndex = groqSttKeyIndex;
  groqSttKeyIndex = (groqSttKeyIndex + 1) % apiKeys.length;

  for (let i = 0; i < apiKeys.length; i++) {
    const currentIndex = (startIndex + i) % apiKeys.length;
    const apiKey = apiKeys[currentIndex];

    const boundary = `----VoiceBotSttBoundary${Date.now()}`;
    const fields = [
      { name: 'model', value: 'whisper-large-v3-turbo' },
      { name: 'language', value: config.stt.language || 'hi' },
      { name: 'response_format', value: 'json' },
      { name: 'temperature', value: '0.0' },
    ];

    let header = '';
    for (const field of fields) {
      header += `--${boundary}\r\n`;
      header += `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`;
      header += `${field.value}\r\n`;
    }
    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
    header += `Content-Type: audio/wav\r\n\r\n`;

    const headerBuf = Buffer.from(header, 'utf-8');
    const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const bodyBuf = Buffer.concat([headerBuf, fileData, footerBuf]);

    try {
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: bodyBuf,
        timeout: 15000,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq STT error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      return (data.text || '').trim();
    } catch (err) {
      lastError = err;
      logger.warn(`Groq STT key ${currentIndex + 1}/${apiKeys.length} failed: ${err.message}`);
    }
  }
}

/**
 * Transcribes audio online using Google Gemini Multimodal Audio API.
 * Excellent fallback if Groq keys are not set or unavailable.
 */
async function transcribeWithGemini(wavPath) {
  const apiKeys = config.ai.gemini.apiKeys && config.ai.gemini.apiKeys.length > 0
    ? config.ai.gemini.apiKeys
    : (config.ai.gemini.apiKey ? [config.ai.gemini.apiKey] : []);

  if (!apiKeys.length) {
    throw new Error('GEMINI_API_KEYS is not set for Gemini STT');
  }

  const fileData = fs.readFileSync(wavPath);
  const base64Audio = fileData.toString('base64');

  let lastError = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    const model = config.ai.gemini.model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{
        role: 'user',
        parts: [
          { text: 'Transcribe the spoken audio verbatim. Only return the transcribed speech text without any markdown or commentary. If there is no speech or silence, return an empty string.' },
          { inline_data: { mime_type: 'audio/wav', data: base64Audio } }
        ]
      }],
      generationConfig: { temperature: 0.0 }
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 15000,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini STT error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return text.trim();
    } catch (err) {
      lastError = err;
      logger.warn(`Gemini STT key ${i + 1}/${apiKeys.length} failed: ${err.message}`);
    }
  }
  throw new Error(`All Gemini STT keys failed. Last error: ${lastError?.message}`);
}

/**
 * Writes a raw PCM16 mono buffer to a temporary WAV file.
 * Incoming audio from the media/WebSocket bridge is expected as
 * 16-bit PCM, 16kHz, mono (the standard format most STT engines want).
 */
function pcmToWavFile(pcmBuffer, sampleRate = 16000) {
  const wavHeaderSize = 44;
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(wavHeaderSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(1, 22); // NumChannels (mono)
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buffer.writeUInt16LE(2, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, wavHeaderSize);

  const tmpPath = path.join(os.tmpdir(), `voicebot-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

/**
 * Runs whisper.cpp's `main` binary against a WAV file and returns text.
 */
function transcribeWithWhisperCpp(wavPath) {
  return new Promise((resolve, reject) => {
    const { bin, model } = config.stt.whisperCpp;
    const args = [
      '-m', model,
      '-f', wavPath,
      '-l', config.stt.language,
      '-nt',       // no timestamps
      '-otxt',     // output plain text
      '--output-file', wavPath.replace(/\.wav$/, ''),
    ];

    const proc = spawn(bin, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      const txtPath = `${wavPath.replace(/\.wav$/, '')}.txt`;
      if (code !== 0) {
        return reject(new Error(`whisper.cpp exited with code ${code}: ${stderr}`));
      }
      try {
        const text = fs.readFileSync(txtPath, 'utf-8').trim();
        fs.unlinkSync(txtPath);
        resolve(text);
      } catch (err) {
        reject(new Error(`Failed to read whisper.cpp output: ${err.message}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

/**
 * Runs a small Python helper script that uses the faster-whisper library.
 * See backend/scripts/faster_whisper_transcribe.py
 */
function transcribeWithFasterWhisper(wavPath) {
  return new Promise((resolve, reject) => {
    const { script, model, device } = config.stt.fasterWhisper;
    const args = [script, '--audio', wavPath, '--model', model, '--device', device, '--language', config.stt.language];

    const proc = spawn('python3', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`faster-whisper exited with code ${code}: ${stderr}`));
      }
      resolve(stdout.trim());
    });

    proc.on('error', (err) => reject(err));
  });
}

/**
 * Public entry point: transcribe a PCM16 audio buffer to text.
 * Automatically selects the configured engine and cleans up temp files.
 */
async function transcribeAudio(pcmBuffer) {
  const wavPath = pcmToWavFile(pcmBuffer);
  try {
    let text;
    if (config.stt.engine === 'groq' || config.stt.engine === 'auto') {
      try {
        text = await transcribeWithGroq(wavPath);
      } catch (groqErr) {
        logger.warn(`Groq STT failed (${groqErr.message}), falling back to Gemini STT...`);
        text = await transcribeWithGemini(wavPath);
      }
    } else if (config.stt.engine === 'gemini') {
      text = await transcribeWithGemini(wavPath);
    } else if (config.stt.engine === 'fasterwhisper') {
      text = await transcribeWithFasterWhisper(wavPath);
    } else {
      text = await transcribeWithWhisperCpp(wavPath);
    }
    logger.info('Transcription complete', { engine: config.stt.engine, text });
    return text;
  } catch (err) {
    logger.error('Transcription failed across all STT engines', { error: err.message });
    throw err;
  } finally {
    fs.unlink(wavPath, () => {});
  }
}

module.exports = { transcribeAudio, pcmToWavFile };
