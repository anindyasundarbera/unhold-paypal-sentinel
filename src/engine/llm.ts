/**
 * Minimal OpenAI-compatible chat client (Ollama Cloud / Astropods gateway).
 * Uses LLM_PROVIDER_ENDPOINT + LLM_API_KEY + LLM_PROVIDER_MODEL.
 */

export interface LlmResult {
  text: string;
  model: string;
  ms: number;
}

export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_PROVIDER_ENDPOINT);
}

export async function chat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: { timeoutMs?: number; temperature?: number } = {}
): Promise<LlmResult> {
  const endpoint = (process.env.LLM_PROVIDER_ENDPOINT || '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_PROVIDER_MODEL || 'deepseek-v4.1-flash';
  if (!endpoint || !apiKey) throw new Error('LLM is not configured (LLM_PROVIDER_ENDPOINT / LLM_API_KEY).');

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25000);
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0 }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    return { text, model, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first JSON object out of a model reply (handles ```json fences and prose). */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model reply contained no JSON object.');
  return JSON.parse(body.slice(start, end + 1)) as T;
}
