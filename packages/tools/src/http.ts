export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  // Linear-jitter retry on network/5xx; defaults to 2 retries.
  retries?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
  }
}

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, retries = 2, ...init } = opts;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      const text = await res.text();
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) {
          await sleep(backoff(attempt));
          attempt += 1;
          continue;
        }
        throw new HttpError(res.status, url, text);
      }
      return text ? (JSON.parse(text) as T) : (undefined as T);
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err;
      if (attempt < retries) {
        await sleep(backoff(attempt));
        attempt += 1;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`fetchJson exhausted retries to ${url}`);
}

function backoff(attempt: number): number {
  const base = 250 * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
