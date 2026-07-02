// database/sqlite.js
// SQLite persistence layer using better-sqlite3 (synchronous, zero external
// dependencies, free & open-source). Stores calls, transcripts and config.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const logger = require('../backend/logger');

// Ensure the database directory exists
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.db.path);
db.pragma('journal_mode = WAL');

// ---- Schema ----
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    caller_id TEXT,
    caller_name TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT DEFAULT 'in_progress'
  );

  CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL,
    role TEXT NOT NULL,        -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (call_id) REFERENCES calls(id)
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---- Calls ----
function createCall(callId, callerId = null) {
  const stmt = db.prepare(
    `INSERT INTO calls (id, caller_id, started_at, status) VALUES (?, ?, ?, 'in_progress')`
  );
  stmt.run(callId, callerId, new Date().toISOString());
  logger.info('Call record created', { callId, callerId });
}

function endCall(callId, status = 'completed') {
  const stmt = db.prepare(
    `UPDATE calls SET ended_at = ?, status = ? WHERE id = ?`
  );
  stmt.run(new Date().toISOString(), status, callId);
  logger.info('Call record closed', { callId, status });
}

function setCallerName(callId, name) {
  db.prepare(`UPDATE calls SET caller_name = ? WHERE id = ?`).run(name, callId);
}

function getAllCalls(limit = 50) {
  return db
    .prepare(`SELECT * FROM calls ORDER BY started_at DESC LIMIT ?`)
    .all(limit);
}

// ---- Transcripts ----
function saveTranscriptTurn(callId, role, content) {
  const stmt = db.prepare(
    `INSERT INTO transcripts (call_id, role, content, created_at) VALUES (?, ?, ?, ?)`
  );
  stmt.run(callId, role, content, new Date().toISOString());
}

function getTranscript(callId) {
  return db
    .prepare(`SELECT role, content, created_at FROM transcripts WHERE call_id = ? ORDER BY id ASC`)
    .all(callId);
}

// ---- App Config (optional key/value store, e.g. for future dynamic settings) ----
function setConfigValue(key, value) {
  db.prepare(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function getConfigValue(key) {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key);
  return row ? row.value : null;
}

module.exports = {
  db,
  createCall,
  endCall,
  setCallerName,
  getAllCalls,
  saveTranscriptTurn,
  getTranscript,
  setConfigValue,
  getConfigValue,
};
