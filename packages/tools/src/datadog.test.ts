import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatadogClient } from './datadog.js';

describe('DatadogClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds metric query URLs against the configured site', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', series: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const dd = new DatadogClient({ apiKey: 'k', appKey: 'a', site: 'us3.datadoghq.com' });
    await dd.queryMetrics('avg:http.5xx{*}', 1700000000, 1700000060);

    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('expected fetch to be called');
    const [url, init] = call;
    expect(String(url)).toMatch(/^https:\/\/api\.us3\.datadoghq\.com\/api\/v1\/query\?/);
    expect(String(url)).toContain('query=avg%3Ahttp.5xx%7B*%7D');
    expect((init?.headers as Record<string, string>)['DD-API-KEY']).toBe('k');
    expect((init?.headers as Record<string, string>)['DD-APPLICATION-KEY']).toBe('a');
  });
});
