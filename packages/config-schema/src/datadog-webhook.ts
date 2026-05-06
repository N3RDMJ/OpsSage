import { z } from 'zod';

// Datadog ships flexible webhook payloads — operators choose which $TEMPLATES
// to include. We require the small set we actually need; everything else is
// passthrough so a skill can read it.
export const datadogWebhookSchema = z
  .object({
    event_type: z.string().default('alert'),
    alert_id: z.string().optional(),
    alert_transition: z.string().optional(),
    aggregation_key: z.string().optional(),
    alert_query: z.string().optional(),
    alert_metric: z.string().optional(),
    alert_scope: z.string().optional(),
    alert_status: z.string().optional(),
    alert_title: z.string().optional(),
    alert_url: z.string().url().optional(),
    body: z.string().optional(),
    date: z.coerce.number().optional(),
    hostname: z.string().optional(),
    id: z.string().optional(),
    last_updated: z.coerce.number().optional(),
    link: z.string().optional(),
    org_id: z.string().optional(),
    org_name: z.string().optional(),
    priority: z.string().optional(),
    snapshot: z.string().optional(),
    tags: z.string().optional(),
    title: z.string().optional(),
    type: z.string().optional(),
    user: z.string().optional(),
  })
  .passthrough();

export type DatadogWebhook = z.infer<typeof datadogWebhookSchema>;

export function tagsFromString(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(/[,\s]+/)) {
    const idx = part.indexOf(':');
    if (idx > 0) {
      const key = part.slice(0, idx);
      const value = part.slice(idx + 1);
      if (key && value) out[key] = value;
    }
  }
  return out;
}

export function dedupeKey(p: DatadogWebhook): string {
  const agg = p.aggregation_key ?? p.alert_id ?? p.id ?? 'unknown';
  const transition = p.alert_transition ?? p.alert_status ?? 'unknown';
  return `${agg}::${transition}`;
}
