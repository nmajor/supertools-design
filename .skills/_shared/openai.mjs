// Minimal OpenAI chat client for the seo skills' synthesis steps
// (table-stakes/gap extraction, PAA-gap judging, brief assembly, angle
// filtering). Matches the app's model (gpt-4o-2024-08-06, src/generation/llm.ts).
// Uses the `openai` package already in the project. Needs OPENAI_API_KEY.

import OpenAI from 'openai';

export const SEO_LLM_MODEL = process.env.SEO_LLM_MODEL || 'gpt-4o-2024-08-06';

export const openaiConfigured = () => !!process.env.OPENAI_API_KEY;

let _client;
function client() {
  if (!openaiConfigured()) throw new Error('OPENAI_API_KEY not set');
  // Explicit timeout + retries so a stalled request can't hang the pipeline
  // (matches the bounded posture of the other _shared clients).
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 2 });
  return _client;
}

/** Plain text completion. */
export async function chat(prompt, { system, model = SEO_LLM_MODEL, temperature = 0.4 } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const res = await client().chat.completions.create({ model, temperature, messages });
  return res.choices[0]?.message?.content || '';
}

/**
 * JSON-mode completion. Returns a parsed object. The prompt MUST instruct the
 * model to return JSON (OpenAI json_object mode requires the word "json" in the
 * conversation). Retries once on parse failure.
 */
export async function chatJSON(prompt, { system, model = SEO_LLM_MODEL, temperature = 0.3 } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client().chat.completions.create({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages,
    });
    const text = res.choices[0]?.message?.content || '{}';
    try {
      return JSON.parse(text);
    } catch {
      if (attempt === 1) throw new Error(`OpenAI returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}
