require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

async function chatStream(systemPrompt, messages, onChunk, onDone) {
  const stream = await client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages,
  });

  let fullText = '';

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      const text = chunk.delta.text;
      fullText += text;
      if (onChunk) onChunk(text);
    }
  }

  const finalMessage = await stream.finalMessage();
  if (onDone) onDone(fullText, finalMessage);

  return fullText;
}

async function chat(systemPrompt, messages) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages,
  });
  return response.content[0].text;
}

module.exports = { chatStream, chat };
