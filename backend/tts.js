// backend/tts.js
// Text-to-Speech wrapper. Supports two fully free/offline engines:
//   1. Piper TTS  - fast, natural neural voices, runs locally (priority)
//   2. Coqui TTS  - alternative offline neural TTS (Python-based)
//
// Both produce a WAV buffer that the websocket layer streams back to the
// caller as PCM16 audio frames.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config/config');
const logger = require('./logger');
const { synthesizeWithEdgeTTS } = require('./edgetts');

/**
 * Synthesizes speech using Piper TTS (offline, C++ binary).
 * Piper reads text from stdin and writes a WAV file to --output_file.
 */
function synthesizeWithPiper(text) {
  return new Promise((resolve, reject) => {
    const { bin, voiceModel } = config.tts.piper;
    const outPath = path.join(os.tmpdir(), `voicebot-tts-${Date.now()}.wav`);

    const proc = spawn(bin, [
      '--model', voiceModel,
      '--output_file', outPath,
      '--length_scale', '0.92',
      '--noise_scale', '0.667',
      '--noise_w', '0.8'
    ]);

    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Piper exited with code ${code}: ${stderr}`));
      }
      try {
        const audio = fs.readFileSync(outPath);
        fs.unlink(outPath, () => {});
        resolve(audio);
      } catch (err) {
        reject(new Error(`Failed to read Piper output: ${err.message}`));
      }
    });

    proc.on('error', (err) => reject(err));

    // Feed the text to synthesize via stdin
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

/**
 * Synthesizes speech using Coqui TTS via its Python CLI
 * (`tts --text ... --out_path ...`). Requires: pip install TTS
 */
function synthesizeWithCoqui(text) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `voicebot-tts-${Date.now()}.wav`);
    const args = [
      '--text', text,
      '--model_name', 'tts_models/hi/male/vits', // example free Hindi Coqui model
      '--out_path', outPath,
    ];

    const proc = spawn('tts', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Coqui TTS exited with code ${code}: ${stderr}`));
      }
      try {
        const audio = fs.readFileSync(outPath);
        fs.unlink(outPath, () => {});
        resolve(audio);
      } catch (err) {
        reject(new Error(`Failed to read Coqui TTS output: ${err.message}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

/**
 * Public entry point: synthesize `text` into a WAV audio buffer.
 */
async function synthesizeSpeech(text) {
  try {
    let audio;
    if (config.tts.engine === 'edgetts' || config.tts.engine === 'auto') {
      try {
        audio = await synthesizeWithEdgeTTS(text, config.tts.edgeVoice || 'hi-IN-SwaraNeural');
      } catch (edgeErr) {
        logger.warn('Edge TTS failed, falling back to Piper offline TTS', { error: edgeErr.message });
        audio = await synthesizeWithPiper(text);
      }
    } else {
      try {
        if (config.tts.engine === 'coqui') {
          audio = await synthesizeWithCoqui(text);
        } else {
          audio = await synthesizeWithPiper(text);
        }
      } catch (localErr) {
        logger.warn(`Local TTS (${config.tts.engine}) failed (${localErr.message}), falling back to online Edge TTS...`);
        audio = await synthesizeWithEdgeTTS(text, config.tts.edgeVoice || 'hi-IN-SwaraNeural');
      }
    }
    logger.info('TTS synthesis complete', { engine: config.tts.engine, chars: text.length });
    return audio;
  } catch (err) {
    logger.error('TTS synthesis failed', { engine: config.tts.engine, error: err.message });
    throw err;
  }
}

module.exports = { synthesizeSpeech };
