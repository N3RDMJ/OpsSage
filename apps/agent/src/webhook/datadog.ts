import { timingSafeEqual } from 'node:crypto';
import { datadogWebhookSchema, dedupeKey, tagsFromString } from '@opssage/config-schema';
import type { langfuse as lf } from '@opssage/tools';
import { Hono } from 'hono';
import type { ChatAdapter } from '../chat/slack.js';
import { TtlLru } from '../dedupe.js';
import { logger } from '../log.js';
import type { OpsSageAgent } from '../session.js';

export interface WebhookDeps {
  webhookSecret: string;
  agent: OpsSageAgent;
  chat: ChatAdapter;
  tracer: lf.LangfuseClient;
  alertChannel: string;
}

const recentEvents = new TtlLru<string, true>(500, 5 * 60_000);

export function buildWebhookRoutes(deps: WebhookDeps): Hono {
  const app = new Hono();

  app.post('/v1/events/datadog', async (c) => {
    const provided = c.req.header('X-OpsSage-Secret') ?? '';
    if (!constantTimeEqual(provided, deps.webhookSecret)) {
      logger.warn('datadog webhook rejected: bad secret');
      return c.json({ error: 'unauthorized' }, 401);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = datadogWebhookSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('datadog webhook rejected: schema', { issues: parsed.error.issues });
      return c.json({ error: 'invalid_payload', issues: parsed.error.issues }, 400);
    }
    const payload = parsed.data;
    const key = dedupeKey(payload);
    if (recentEvents.has(key)) {
      return c.json({ status: 'duplicate', key }, 200);
    }
    recentEvents.set(key, true);

    const sessionId = `${key}-${Date.now().toString(36)}`;
    logger.info('datadog webhook accepted', {
      sessionId,
      alert_id: payload.alert_id,
      transition: payload.alert_transition,
      service: tagsFromString(payload.tags).service,
    });

    // Run the session detached so we can ack the webhook quickly. Datadog
    // retries on non-2xx, and the agent run can take 30–90s.
    void (async () => {
      try {
        const summary = await deps.agent.triage({ alert: payload, sessionId });
        logger.info('triage complete', { sessionId, hypothesis: summary.hypothesis });

        const target = payload.alert_url
          ? await deps.chat.locateAlertThread({
              channel: deps.alertChannel,
              alertUrl: payload.alert_url,
            })
          : undefined;
        const replyArgs: Parameters<ChatAdapter['reply']>[0] = {
          target: target ?? { channel: deps.alertChannel },
          summary,
          ...(payload.alert_url !== undefined ? { alertUrl: payload.alert_url } : {}),
        };
        await deps.chat.reply(replyArgs);
      } catch (err) {
        logger.error('triage failed', { sessionId, err: String(err) });
      } finally {
        await deps.tracer.flush();
      }
    })();

    return c.json({ status: 'accepted', sessionId }, 202);
  });

  return app;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}
