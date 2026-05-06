import { describe, expect, it, vi } from 'vitest';
import { buildWebhookRoutes } from './datadog.js';

function fakeDeps() {
  const tracer = { flush: vi.fn().mockResolvedValue(undefined) };
  return {
    webhookSecret: 'shh',
    alertChannel: '#alerts',
    agent: { triage: vi.fn().mockResolvedValue({
      hypothesis: 'test',
      evidence: [],
      suggested_next_step: 'noop',
      linked_artifacts: [],
      confidence: 'low',
    }) },
    // biome-ignore lint/suspicious/noExplicitAny: test stub for langfuse
    tracer: tracer as any,
    chat: { locateAlertThread: vi.fn(), reply: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('webhook routes', () => {
  it('rejects requests with a wrong secret', async () => {
    const app = buildWebhookRoutes(fakeDeps());
    const res = await app.request('/v1/events/datadog', {
      method: 'POST',
      headers: { 'X-OpsSage-Secret': 'wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert_id: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects payloads that fail schema validation', async () => {
    const app = buildWebhookRoutes(fakeDeps());
    const res = await app.request('/v1/events/datadog', {
      method: 'POST',
      headers: { 'X-OpsSage-Secret': 'shh', 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('accepts valid payloads and acks 202', async () => {
    const app = buildWebhookRoutes(fakeDeps());
    const res = await app.request('/v1/events/datadog', {
      method: 'POST',
      headers: { 'X-OpsSage-Secret': 'shh', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'alert',
        alert_id: 'abc',
        aggregation_key: 'agg-1',
        alert_transition: 'Triggered',
      }),
    });
    expect(res.status).toBe(202);
  });
});
