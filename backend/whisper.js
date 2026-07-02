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
const config = require('../config/config');
const logger = require('./logger');

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
    if (config.stt.engine === 'fasterwhisper') {
      text = await transcribeWithFasterWhisper(wavPath);
    } else {
      text = await transcribeWithWhisperCpp(wavPath);
    }
    logger.info('Transcription complete', { engine: config.stt.engine, text });
    return text;
  } catch (err) {
    logger.error('Transcription failed', { engine: config.stt.engine, error: err.message });
    throw err;
  } finally {
    fs.unlink(wavPath, () => {});
  }
}

module.exports = { transcribeAudio, pcmToWavFile };
