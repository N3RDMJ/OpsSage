import { fetchJson } from './http.js';

export interface DatadogConfig {
  apiKey: string;
  appKey: string;
  /** e.g. `datadoghq.com`, `us3.datadoghq.com`, `datadoghq.eu` */
  site?: string;
}

export class DatadogClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly cfg: DatadogConfig) {
    this.base = `https://api.${cfg.site ?? 'datadoghq.com'}`;
    this.headers = {
      'DD-API-KEY': cfg.apiKey,
      'DD-APPLICATION-KEY': cfg.appKey,
      'Content-Type': 'application/json',
    };
  }

  /** Query a metric series — wraps `/api/v1/query`. */
  queryMetrics(query: string, fromSec: number, toSec: number): Promise<DatadogMetricsResponse> {
    const u = new URL('/api/v1/query', this.base);
    u.searchParams.set('query', query);
    u.searchParams.set('from', String(fromSec));
    u.searchParams.set('to', String(toSec));
    return fetchJson(u.toString(), { headers: this.headers });
  }

  /** Search logs — wraps `/api/v2/logs/events/search`. */
  searchLogs(body: DatadogLogsSearch): Promise<DatadogLogsResponse> {
    return fetchJson(`${this.base}/api/v2/logs/events/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
  }

  /** Read a monitor by id. */
  getMonitor(id: number | string): Promise<DatadogMonitor> {
    return fetchJson(`${this.base}/api/v1/monitor/${id}`, { headers: this.headers });
  }

  /** Search APM spans — wraps `/api/v2/spans/events/search`. */
  searchSpans(body: DatadogSpansSearch): Promise<DatadogSpansResponse> {
    return fetchJson(`${this.base}/api/v2/spans/events/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
  }

  /** Pull recent deployments via the Events API. */
  recentDeployments(
    service: string,
    fromSec: number,
    toSec: number,
  ): Promise<DatadogEventsResponse> {
    const u = new URL('/api/v1/events', this.base);
    u.searchParams.set('start', String(fromSec));
    u.searchParams.set('end', String(toSec));
    u.searchParams.set('tags', `source:deployment,service:${service}`);
    return fetchJson(u.toString(), { headers: this.headers });
  }
}

// Minimal response shapes — we type only fields the agent actually reads, and
// keep the rest as passthrough.
export interface DatadogMetricsResponse {
  status?: string;
  series?: Array<{
    metric?: string;
    pointlist?: Array<[number, number]>;
    scope?: string;
    tag_set?: string[];
  }>;
  [k: string]: unknown;
}

export interface DatadogLogsSearch {
  filter: { query: string; from: string; to: string };
  page?: { limit?: number };
  sort?: string;
}

export interface DatadogLogsResponse {
  data?: Array<{ id?: string; attributes?: Record<string, unknown> }>;
  meta?: Record<string, unknown>;
}

export interface DatadogSpansSearch {
  filter: { query: string; from: string; to: string };
  page?: { limit?: number };
}

export interface DatadogSpansResponse {
  data?: Array<{ id?: string; attributes?: Record<string, unknown> }>;
}

export interface DatadogMonitor {
  id?: number;
  name?: string;
  message?: string;
  query?: string;
  type?: string;
  tags?: string[];
  [k: string]: unknown;
}

export interface DatadogEventsResponse {
  events?: Array<{
    id?: number;
    title?: string;
    text?: string;
    date_happened?: number;
    tags?: string[];
    url?: string;
  }>;
}
