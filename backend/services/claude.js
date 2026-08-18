require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4096;

// El system prompt de un agente (prompt base + directorio de equipo, etc.)
// es idéntico entre mensajes consecutivos de la misma conversación en la
// gran mayoría de los casos (grupo interno, 1:1 con equipo) — cachearlo
// evita reprocesar ese bloque grande en cada turno y acelera la respuesta.
function systemConCache(systemPrompt) {
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
}

async function chatStream(systemPrompt, messages, onChunk, onDone, signal) {
  const stream = await client.messages.stream(
    { model: MODEL, max_tokens: MAX_TOKENS, system: systemConCache(systemPrompt), messages },
    signal ? { signal } : {}
  );

  let fullText = '';

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      const text = chunk.delta.text;
      fullText += text;
      if (onChunk) onChunk(text);
    }
  }

  if (!signal?.aborted) {
    const finalMessage = await stream.finalMessage();
    if (onDone) onDone(fullText, finalMessage);
  }

  return fullText;
}

async function chat(systemPrompt, messages, { maxTokens } = {}) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens || MAX_TOKENS,
    system: systemConCache(systemPrompt),
    messages,
  });
  return response.content[0].text;
}

module.exports = { chatStream, chat };
