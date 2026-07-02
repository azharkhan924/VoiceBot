// backend/memory.js
// Maintains in-memory conversation history for each active call.
// Memory is keyed by callId and is wiped as soon as the call ends.

const logger = require('./logger');

/**
 * Map<callId, {
 *   history: [{ role: 'user'|'assistant', content: string }],
 *   callerName: string|null,
 *   startedAt: Date
 * }>
 */
const sessions = new Map();

function createSession(callId) {
  sessions.set(callId, {
    history: [],
    callerName: null,
    startedAt: new Date(),
  });
  logger.info('Memory session created', { callId });
  return sessions.get(callId);
}

function getSession(callId) {
  return sessions.get(callId);
}

function addTurn(callId, role, content) {
  const session = sessions.get(callId) || createSession(callId);
  session.history.push({ role, content });
  return session;
}

function setCallerName(callId, name) {
  const session = sessions.get(callId) || createSession(callId);
  session.callerName = name;
}

function getHistory(callId) {
  const session = sessions.get(callId);
  return session ? session.history : [];
}

function endSession(callId) {
  const session = sessions.get(callId);
  sessions.delete(callId);
  logger.info('Memory session cleared', { callId });
  return session; // returned so caller can persist the transcript before wiping
}

module.exports = {
  createSession,
  getSession,
  addTurn,
  setCallerName,
  getHistory,
  endSession,
};
