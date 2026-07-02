// backend/mulaw.js
// Pure JavaScript G.711 µ-law encoder and decoder with automatic sample rate
// conversion (8kHz µ-law <-> 16kHz/22.05kHz PCM16). Zero native dependencies.

const MULAW_BIAS = 0x84;
const CLIP = 8159;

// Precompute 256-entry decoding table (µ-law byte -> 16-bit PCM)
const MULAW_TO_PCM16 = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let muByte = ~i & 0xFF;
  const sign = (muByte & 0x80) ? -1 : 1;
  const exponent = (muByte >> 4) & 0x07;
  const mantissa = muByte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  MULAW_TO_PCM16[i] = sign * sample;
}

// Precompute 65536-entry encoding table (16-bit PCM -> µ-law byte)
const PCM16_TO_MULAW = new Uint8Array(65536);
for (let i = -32768; i <= 32767; i++) {
  let pcm = i;
  let sign = (pcm < 0) ? 0x80 : 0x00;
  if (pcm < 0) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  let mantissa = (pcm >> (exponent + 3)) & 0x0F;
  let muByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  // Map signed 16-bit int (-32768..32767) to unsigned 16-bit index (0..65535)
  PCM16_TO_MULAW[(i + 65536) & 0xFFFF] = muByte;
}

/**
 * Decodes a Buffer of 8kHz µ-law audio to a Buffer of 16kHz 16-bit PCM audio.
 * Upsamples by 2x (each 8kHz sample becomes two 16kHz samples).
 * @param {Buffer} mulawBuffer - Raw 8kHz µ-law bytes
 * @returns {Buffer} 16kHz PCM16 mono buffer
 */
function decodeMulaw8kToPcm16k(mulawBuffer) {
  const pcmBuffer = Buffer.alloc(mulawBuffer.length * 4); // 2 samples * 2 bytes per sample
  let outOffset = 0;
  for (let i = 0; i < mulawBuffer.length; i++) {
    const pcmSample = MULAW_TO_PCM16[mulawBuffer[i]];
    pcmBuffer.writeInt16LE(pcmSample, outOffset);
    pcmBuffer.writeInt16LE(pcmSample, outOffset + 2);
    outOffset += 4;
  }
  return pcmBuffer;
}

/**
 * Encodes a Buffer of PCM16 audio (at any input sample rate, e.g. 16000 or 22050 Hz)
 * to an 8kHz µ-law Buffer suitable for Twilio Media Streams.
 * Can take either raw PCM buffer or a WAV file buffer (skips WAV header if present).
 * @param {Buffer} pcmOrWavBuffer - Input audio buffer
 * @param {number} inputSampleRate - Input rate (defaults to 16000)
 * @returns {Buffer} 8kHz µ-law buffer
 */
function encodePcmToMulaw8k(pcmOrWavBuffer, inputSampleRate = 16000) {
  let pcmData = pcmOrWavBuffer;
  let sampleRate = inputSampleRate;

  // Check if buffer is a WAV file (starts with 'RIFF')
  if (pcmOrWavBuffer.length > 44 && pcmOrWavBuffer.toString('ascii', 0, 4) === 'RIFF') {
    // Read actual sample rate from WAV header byte 24
    sampleRate = pcmOrWavBuffer.readUInt32LE(24);
    pcmData = pcmOrWavBuffer.slice(44);
  }

  const numInputSamples = Math.floor(pcmData.length / 2);
  const ratio = sampleRate / 8000;
  const numOutputSamples = Math.floor(numInputSamples / ratio);
  const mulawBuffer = Buffer.alloc(numOutputSamples);

  for (let i = 0; i < numOutputSamples; i++) {
    const srcIndex = Math.floor(i * ratio) * 2;
    if (srcIndex + 1 < pcmData.length) {
      const pcmSample = pcmData.readInt16LE(srcIndex);
      const uintIndex = (pcmSample + 65536) & 0xFFFF;
      mulawBuffer[i] = PCM16_TO_MULAW[uintIndex];
    }
  }
  return mulawBuffer;
}

/**
 * Calculates RMS (Root Mean Square) energy of a 16-bit PCM buffer.
 * Useful for Voice Activity Detection (VAD) / pause detection.
 * @param {Buffer} pcmBuffer - 16-bit PCM buffer
 * @returns {number} RMS energy level (0 to 32768)
 */
function calculatePcmEnergy(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 2) return 0;
  let sumSquares = 0;
  const samples = Math.floor(pcmBuffer.length / 2);
  for (let i = 0; i < samples * 2; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

module.exports = {
  decodeMulaw8kToPcm16k,
  encodePcmToMulaw8k,
  calculatePcmEnergy,
};
