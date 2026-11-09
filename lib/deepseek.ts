// Klien DeepSeek murni berbasis fetch (tanpa SDK / framework).

export type DeepSeekModel = 'deepseek-reasoner' | 'deepseek-chat';

export interface DeepSeekResult {
  content: string;
  reasoning: string;
  usage: Record<string, unknown> | null;
  finishReason: string;
}

export interface DeepSeekOptions {
  model: DeepSeekModel;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number; // diabaikan untuk deepseek-reasoner
  timeoutMs?: number;
  retries?: number;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callDeepSeek(opts: DeepSeekOptions): Promise<DeepSeekResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY belum diset');

  const { model, system, user } = opts;
  const retries = opts.retries ?? 1;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 200_000);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: opts.maxTokens ?? 8192,
    stream: false,
  };
  // deepseek-reasoner menolak/mengabaikan parameter sampling.
  if (model === 'deepseek-chat' && opts.temperature !== undefined) body.temperature = opts.temperature;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(res.status, `DeepSeek HTTP ${res.status}: ${text.slice(0, 400)}`);
      }

      const json = (await res.json()) as any;
      const choice = json?.choices?.[0];
      const content: string = choice?.message?.content ?? '';
      const reasoning: string = choice?.message?.reasoning_content ?? '';
      const finishReason: string = choice?.finish_reason ?? 'unknown';

      if (!content.trim()) {
        throw new Error(
          `DeepSeek mengembalikan konten kosong (finish_reason=${finishReason}). ` +
            `Jika "length", naikkan max_tokens (reasoning bisa menghabiskan kuota).`
        );
      }
      if (finishReason === 'length') {
        throw new Error('Output terpotong (finish_reason=length). Naikkan max_tokens atau perpendek instruksi.');
      }
      return { content, reasoning, usage: json?.usage ?? null, finishReason };
    } catch (err) {
      lastError = err;
      const status = err instanceof HttpError ? err.status : 0;
      const retryable = status === 0 || status === 429 || status >= 500; // network/timeout/429/5xx
      if (!retryable || attempt === retries) break;
      await sleep(2000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Ambil objek JSON dari output LLM, toleran terhadap code fence / teks di sekitarnya. */
export function extractJson<T = any>(raw: string): T {
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Output agen bukan JSON yang valid');
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch (e) {
    throw new Error(`Gagal parse JSON agen: ${(e as Error).message}`);
  }
}
