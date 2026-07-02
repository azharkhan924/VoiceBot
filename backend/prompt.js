// backend/prompt.js
// Loads the system prompt from config/prompt.txt and watches the file
// for changes so behavior updates take effect immediately without a
// server restart.

const fs = require('fs');
const chokidar = require('chokidar');
const config = require('../config/config');
const logger = require('./logger');

let currentPrompt = '';

function loadPrompt() {
  try {
    currentPrompt = fs.readFileSync(config.promptPath, 'utf-8').trim();
    logger.info('System prompt (re)loaded', { length: currentPrompt.length });
  } catch (err) {
    logger.error('Failed to load prompt.txt, using fallback prompt', { error: err.message });
    currentPrompt = 'You are a polite Hindi-speaking customer support executive. Keep replies short.';
  }
  return currentPrompt;
}

// Initial load
loadPrompt();

// Watch for edits so changing config/prompt.txt instantly changes bot behavior
chokidar.watch(config.promptPath).on('change', () => {
  logger.info('Detected change in prompt.txt, reloading...');
  loadPrompt();
});

function getPrompt() {
  return currentPrompt;
}

module.exports = { getPrompt, loadPrompt };
