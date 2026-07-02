// backend/websocket.js
// Orchestrates the full incoming-call flow over a WebSocket connection.
// Supports both standard binary PCM16 frames and Twilio Media Streams protocol.

const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const memory = require('./memory');
const db = require('../database/sqlite');
const { transcribeAudio } = require('./whisper');
const { synthesizeSpeech } = require('./tts');
const { getAIReply } = require('./ai');
const { decodeMulaw8kToPcm16k, encodePcmToMulaw8k, calculatePcmEnergy } = require('./mulaw');

const GREETING = 'नमस्कार! मैं आपकी सहायता के लिए उपलब्ध हूँ। कृपया बताइए मैं आपकी कैसे मदद कर सकता हूँ?';
const GOODBYE = 'धन्यवाद। आपका दिन शुभ हो।';
const NOT_UNDERSTOOD = 'क्षमा कीजिए, आपकी बात स्पष्ट सुनाई नहीं दी। कृपया दोबारा बोलिए।';
const AI_UNAVAILABLE = 'क्षमा कीजिए, इस समय तकनीकी समस्या है।';

const END_KEYWORDS = ['धन्यवाद', 'धन्यवाद।', 'ठीक है', 'अलविदा', 'bye', 'byee', 'goodbye'];

function isEndOfCall(text) {
  const normalized = text.trim().toLowerCase();
  return END_KEYWORDS.some((kw) => normalized.includes(kw.toLowerCase()));
}

function sendJSON(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendAudio(ws, buffer) {
  if (ws.readyState === ws.OPEN) {
    ws.send(buffer);
  }
}

/** Speak `text`: synthesize with TTS, send audio + save transcript + memory. */
async function speak(ws, callState, text) {
  if (!callState.callId || ws.readyState !== ws.OPEN) return;
  sendJSON(ws, { type: 'reply', text });
  memory.addTurn(callState.callId, 'assistant', text);
  db.saveTranscriptTurn(callState.callId, 'assistant', text);
  try {
    const audio = await synthesizeSpeech(text);
    if (!callState.callId || ws.readyState !== ws.OPEN) return;
    if (callState.isTwilio && callState.streamSid) {
      // Convert synthesized WAV/PCM audio to 8kHz µ-law chunks for Twilio Media Streams
      const mulawBuffer = encodePcmToMulaw8k(audio);
      const chunkSize = 4000; // ~500ms chunks
      for (let i = 0; i < mulawBuffer.length; i += chunkSize) {
        const slice = mulawBuffer.slice(i, i + chunkSize);
        sendJSON(ws, {
          event: 'media',
          streamSid: callState.streamSid,
          media: { payload: slice.toString('base64') },
        });
      }
    } else {
      sendAudio(ws, audio);
    }
  } catch (err) {
    logger.error('Failed to synthesize/send speech', { callId: callState.callId, error: err.message });
  }
}

async function processUtterance(ws, callState) {
  if (callState.isProcessing || !callState.callId) return;
  callState.isProcessing = true;

  if (callState.silenceTimer) {
    clearTimeout(callState.silenceTimer);
    callState.silenceTimer = null;
  }

  const pcmBuffer = Buffer.concat(callState.audioChunks);
  callState.audioChunks = [];
  callState.isSpeaking = false;

  // Ignore very short bursts (<100ms)
  if (pcmBuffer.length < 3200) {
    callState.isProcessing = false;
    return;
  }

  // ---- Speech to Text ----
  let userText;
  try {
    userText = await transcribeAudio(pcmBuffer);
  } catch (err) {
    logger.error('STT failed', { callId: callState.callId, error: err.message });
    if (!callState.isTwilio) {
      await speak(ws, callState, NOT_UNDERSTOOD);
    }
    callState.isProcessing = false;
    return;
  }

  if (!callState.callId || ws.readyState !== ws.OPEN) {
    callState.isProcessing = false;
    return;
  }

  if (!userText || userText.trim().length === 0) {
    if (!callState.isTwilio) {
      await speak(ws, callState, NOT_UNDERSTOOD);
    }
    callState.isProcessing = false;
    return;
  }

  logger.info('Caller said', { callId: callState.callId, userText });
  sendJSON(ws, { type: 'transcript', role: 'user', text: userText });
  memory.addTurn(callState.callId, 'user', userText);
  db.saveTranscriptTurn(callState.callId, 'user', userText);

  // ---- Check for end-of-call keywords ----
  if (isEndOfCall(userText)) {
    await speak(ws, callState, GOODBYE);
    finalizeCall(ws, callState, 'completed');
    return;
  }

  // ---- Get AI reply (with conversation memory) ----
  let aiText;
  try {
    const history = memory.getHistory(callState.callId).slice(0, -1);
    aiText = await getAIReply(history, userText);
  } catch (err) {
    await speak(ws, callState, AI_UNAVAILABLE);
    callState.isProcessing = false;
    return;
  }

  await speak(ws, callState, aiText);
  callState.isProcessing = false;
}

function attachWebSocketHandlers(wss) {
  wss.on('connection', (ws) => {
    const callState = {
      callId: null,
      callerId: null,
      audioChunks: [],
      isTwilio: false,
      streamSid: null,
      silenceTimer: null,
      isSpeaking: false,
      isProcessing: false,
    };

    logger.info('New WebSocket connection opened');

    ws.on('message', async (message, isBinary) => {
      try {
        // ---- Binary frame: raw caller audio (Browser / Test Client) ----
        if (isBinary) {
          if (!callState.isProcessing) {
            callState.audioChunks.push(message);

            // Server-side silence detection (VAD) for browser binary frames
            const energy = calculatePcmEnergy(message);
            if (energy > 150) {
              callState.isSpeaking = true;
              if (callState.silenceTimer) {
                clearTimeout(callState.silenceTimer);
                callState.silenceTimer = null;
              }
            } else if (callState.isSpeaking && callState.audioChunks.length > 3) {
              if (!callState.silenceTimer) {
                callState.silenceTimer = setTimeout(() => processUtterance(ws, callState), 800);
              }
            }
          }
          return;
        }

        // ---- Text frame: JSON control message or Twilio Media Stream ----
        const data = JSON.parse(message.toString());

        // 1. Twilio Media Streams Protocol
        if (data.event) {
          switch (data.event) {
            case 'connected':
              logger.info('Twilio media stream connected');
              break;

            case 'start': {
              callState.isTwilio = true;
              callState.streamSid = data.start.streamSid;
              callState.callId = data.start.callSid || uuidv4();
              callState.callerId = data.start.customParameters?.callerId || '+1-Twilio-Caller';
              memory.createSession(callState.callId);
              db.createCall(callState.callId, callState.callerId);
              logger.info('Twilio call started', { callId: callState.callId, streamSid: callState.streamSid });

              await speak(ws, callState, GREETING);
              break;
            }

            case 'media': {
              if (callState.isProcessing) return; // Don't accumulate speech while bot is replying
              const mulawChunk = Buffer.from(data.media.payload, 'base64');
              const pcmChunk = decodeMulaw8kToPcm16k(mulawChunk);
              callState.audioChunks.push(pcmChunk);

              // Server-side silence detection (VAD) for live telephony streams
              const energy = calculatePcmEnergy(pcmChunk);
              if (energy > 300) {
                callState.isSpeaking = true;
                if (callState.silenceTimer) {
                  clearTimeout(callState.silenceTimer);
                  callState.silenceTimer = null;
                }
              } else if (callState.isSpeaking && callState.audioChunks.length > 5) {
                if (!callState.silenceTimer) {
                  // After 900ms of continuous silence, process the speech
                  callState.silenceTimer = setTimeout(() => processUtterance(ws, callState), 900);
                }
              }
              break;
            }

            case 'stop': {
              logger.info('Twilio stream stopped');
              if (callState.callId) {
                finalizeCall(ws, callState, 'completed');
              }
              break;
            }
          }
          return;
        }

        // 2. Standard Voice Bot Protocol (Browser / Test Client)
        switch (data.type) {
          case 'start_call': {
            callState.callId = data.callId || uuidv4();
            callState.callerId = data.callerId || null;
            memory.createSession(callState.callId);
            db.createCall(callState.callId, callState.callerId);
            logger.info('Call started', { callId: callState.callId, callerId: callState.callerId });

            await speak(ws, callState, GREETING);
            break;
          }

          case 'utterance_end': {
            if (!callState.callId) {
              sendJSON(ws, { type: 'error', text: 'Call not started' });
              return;
            }
            await processUtterance(ws, callState);
            break;
          }

          case 'end_call': {
            if (callState.callId) {
              finalizeCall(ws, callState, 'completed');
            }
            break;
          }

          default:
            logger.warn('Unknown message type received', { type: data.type });
        }
      } catch (err) {
        logger.error('Error handling WebSocket message', { error: err.message, stack: err.stack });
        sendJSON(ws, { type: 'error', text: AI_UNAVAILABLE });
      }
    });

    ws.on('close', () => {
      if (callState.silenceTimer) clearTimeout(callState.silenceTimer);
      if (callState.callId) {
        logger.info('WebSocket closed - finalizing call', { callId: callState.callId });
        finalizeCall(ws, callState, 'disconnected');
      }
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', { error: err.message });
    });
  });
}

/** Persists the call as ended and wipes in-memory conversation state. */
function finalizeCall(ws, callState, status) {
  if (callState.silenceTimer) {
    clearTimeout(callState.silenceTimer);
    callState.silenceTimer = null;
  }
  db.endCall(callState.callId, status);
  memory.endSession(callState.callId);
  sendJSON(ws, { type: 'call_ended' });
  logger.info('Call finalized', { callId: callState.callId, status });
  callState.callId = null;
}

module.exports = { attachWebSocketHandlers };
