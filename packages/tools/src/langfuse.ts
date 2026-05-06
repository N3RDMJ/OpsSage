import { fetchJson } from './http.js';

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host?: string;
}

interface IngestionEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

interface ActiveSpan {
  id: string;
  traceId: string;
  parentId: string | undefined;
  name: string;
  startTime: string;
  metadata?: Record<string, unknown>;
}

/**
 * Tiny Langfuse OpenTelemetry-shaped client. Buffers events and flushes via
 * `/api/public/ingestion`. Designed so that if the Langfuse keys are absent
 * everything no-ops cleanly — Langfuse is observability, not a hard dep.
 */
export class LangfuseClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly buffer: IngestionEvent[] = [];
  private readonly enabled: boolean;

  constructor(cfg: Partial<LangfuseConfig>) {
    this.base = cfg.host ?? 'https://cloud.langfuse.com';
    this.enabled = Boolean(cfg.publicKey && cfg.secretKey);
    this.auth = this.enabled
      ? 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')
      : '';
  }

  trace(input: {
    id?: string;
    name: string;
    input?: unknown;
    userId?: string;
    sessionId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): string {
    const id = input.id ?? randomId();
    this.push('trace-create', {
      id,
      name: input.name,
      input: input.input,
      userId: input.userId,
      sessionId: input.sessionId,
      tags: input.tags,
      metadata: input.metadata,
      timestamp: new Date().toISOString(),
    });
    return id;
  }

  span(input: {
    traceId: string;
    parentId?: string;
    name: string;
    metadata?: Record<string, unknown>;
  }): ActiveSpan {
    const span: ActiveSpan = {
      id: randomId(),
      traceId: input.traceId,
      parentId: input.parentId,
      name: input.name,
      startTime: new Date().toISOString(),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    this.push('span-create', span);
    return span;
  }

  endSpan(span: ActiveSpan, output?: unknown, level: 'DEFAULT' | 'WARN' | 'ERROR' = 'DEFAULT'): void {
    this.push('span-update', {
      id: span.id,
      traceId: span.traceId,
      endTime: new Date().toISOString(),
      output,
      level,
    });
  }

  generation(input: {
    traceId: string;
    parentId?: string;
    name: string;
    model: string;
    input: unknown;
    output: unknown;
    usage?: { input?: number; output?: number; total?: number };
    metadata?: Record<string, unknown>;
  }): void {
    const id = randomId();
    const now = new Date().toISOString();
    this.push('generation-create', {
      id,
      traceId: input.traceId,
      parentObservationId: input.parentId,
      name: input.name,
      model: input.model,
      input: input.input,
      output: input.output,
      usage: input.usage,
      metadata: input.metadata,
      startTime: now,
      endTime: now,
    });
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await fetchJson(`${this.base}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          Authorization: this.auth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ batch }),
        timeoutMs: 10_000,
      });
    } catch (err) {
      // Don't let observability break the agent.
      console.warn('langfuse flush failed:', err instanceof Error ? err.message : err);
    }
  }

  private push(type: string, body: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.buffer.push({
      id: randomId(),
      type,
      timestamp: new Date().toISOString(),
      body,
    });
  }
}

function randomId(): string {
  // 16 bytes of randomness rendered as hex.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
