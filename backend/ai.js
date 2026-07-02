// backend/ai.js
// Abstraction layer over free LLM providers (Gemini 2.5 Flash / Groq).
// Switch providers via API_PROVIDER env variable - no code changes needed.

const fetch = require('node-fetch');
const config = require('../config/config');
const logger = require('./logger');
const { getPrompt } = require('./prompt');

const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

let geminiKeyIndex = 0;
let groqKeyIndex = 0;
let autoProviderTurn = 0;

/**
 * Calls Google Gemini free API.
 * history: [{ role: 'user'|'assistant', content }]
 */
async function callGemini(systemPrompt, history, userMessage, apiKey, model) {
  const targetKey = apiKey || config.ai.gemini.apiKey;
  const targetModel = model || config.ai.gemini.model;
  if (!targetKey) throw new Error('GEMINI_API_KEY is not set');

  // Gemini expects roles 'user' / 'model'
  const contents = history.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 200,
    },
  };

  const res = await fetch(GEMINI_URL(targetModel, targetKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 15000,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) throw new Error('Gemini returned an empty response');
  return reply.trim();
}

/**
 * Calls Groq free API (OpenAI-compatible chat completion format).
 */
async function callGroq(systemPrompt, history, userMessage, apiKey, model) {
  const targetKey = apiKey || config.ai.groq.apiKey;
  const targetModel = model || config.ai.groq.model;
  if (!targetKey) throw new Error('GROQ_API_KEY is not set');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: userMessage },
  ];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${targetKey}`,
    },
    body: JSON.stringify({
      model: targetModel,
      messages,
      temperature: 0.6,
      max_tokens: 200,
    }),
    timeout: 15000,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Groq returned an empty response');
  return reply.trim();
}

async function callProviderWithRotation(providerName, systemPrompt, history, userMessage) {
  const providerConfig = config.ai[providerName];
  if (!providerConfig) {
    throw new Error(`Unknown provider configuration: ${providerName}`);
  }
  const apiKeys = providerConfig.apiKeys && providerConfig.apiKeys.length > 0
    ? providerConfig.apiKeys
    : (providerConfig.apiKey ? [providerConfig.apiKey] : []);

  if (apiKeys.length === 0) {
    throw new Error(`No API keys configured for provider: ${providerName}`);
  }

  let startIndex = providerName === 'gemini' ? geminiKeyIndex : groqKeyIndex;
  // Advance the index for the next call (round-robin)
  if (providerName === 'gemini') {
    geminiKeyIndex = (geminiKeyIndex + 1) % apiKeys.length;
  } else {
    groqKeyIndex = (groqKeyIndex + 1) % apiKeys.length;
  }

  let lastError = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const currentIndex = (startIndex + i) % apiKeys.length;
    const apiKey = apiKeys[currentIndex];
    const maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '***';

    try {
      logger.info(`Attempting AI call with ${providerName} (key ${currentIndex + 1}/${apiKeys.length}: ${maskedKey})`);
      let reply;
      if (providerName === 'gemini') {
        reply = await callGemini(systemPrompt, history, userMessage, apiKey, providerConfig.model);
      } else if (providerName === 'groq') {
        reply = await callGroq(systemPrompt, history, userMessage, apiKey, providerConfig.model);
      } else {
        throw new Error(`Unsupported provider function for: ${providerName}`);
      }
      return reply;
    } catch (err) {
      lastError = err;
      logger.warn(`${providerName} call failed with key ${currentIndex + 1}/${apiKeys.length} (${maskedKey}): ${err.message}`);
    }
  }

  throw new Error(`All ${apiKeys.length} API keys failed for provider ${providerName}. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
}

/**
 * Public entry point. Picks the configured provider and returns the AI's
 * reply text. Supports round-robin key rotation and automatic failover.
 */
async function getAIReply(history, userMessage) {
  const systemPrompt = getPrompt();
  let provider = config.ai.provider;

  // Support auto / all / both / roundrobin provider modes
  if (provider === 'auto' || provider === 'all' || provider === 'both' || provider === 'roundrobin') {
    const providers = [];
    if (config.ai.gemini.apiKeys && config.ai.gemini.apiKeys.length > 0) providers.push('gemini');
    if (config.ai.groq.apiKeys && config.ai.groq.apiKeys.length > 0) providers.push('groq');
    if (providers.length > 0) {
      provider = providers[autoProviderTurn % providers.length];
      autoProviderTurn = (autoProviderTurn + 1) % providers.length;
    } else {
      provider = 'gemini';
    }
  }

  logger.info('Sending message to AI provider', { provider, userMessage });

  try {
    if (provider === 'gemini') {
      try {
        const reply = await callProviderWithRotation('gemini', systemPrompt, history, userMessage);
        logger.info('AI reply received', { provider: 'gemini', reply });
        return reply;
      } catch (geminiErr) {
        // Fallback to Groq if configured
        if (config.ai.groq.apiKeys && config.ai.groq.apiKeys.length > 0) {
          logger.warn(`Gemini provider failed (${geminiErr.message}). Falling back to Groq...`);
          const reply = await callProviderWithRotation('groq', systemPrompt, history, userMessage);
          logger.info('AI reply received via fallback', { provider: 'groq', reply });
          return reply;
        }
        throw geminiErr;
      }
    } else if (provider === 'groq') {
      try {
        const reply = await callProviderWithRotation('groq', systemPrompt, history, userMessage);
        logger.info('AI reply received', { provider: 'groq', reply });
        return reply;
      } catch (groqErr) {
        // Fallback to Gemini if configured
        if (config.ai.gemini.apiKeys && config.ai.gemini.apiKeys.length > 0) {
          logger.warn(`Groq provider failed (${groqErr.message}). Falling back to Gemini...`);
          const reply = await callProviderWithRotation('gemini', systemPrompt, history, userMessage);
          logger.info('AI reply received via fallback', { provider: 'gemini', reply });
          return reply;
        }
        throw groqErr;
      }
    } else {
      throw new Error(`Unknown API_PROVIDER: ${provider}`);
    }
  } catch (err) {
    logger.error('AI provider call failed across all available keys and providers', { provider, error: err.message });
    throw err;
  }
}

module.exports = { getAIReply };
