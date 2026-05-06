import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { buildChatAdapter } from './chat/slack.js';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './log.js';
import { buildAgent } from './session.js';
import { buildTracer } from './tracing/langfuse.js';
import { buildWebhookRoutes } from './webhook/datadog.js';

async function main() {
  const cfg = await loadConfig();
  setLogLevel(cfg.env.LOG_LEVEL);

  const tracer = buildTracer(cfg.env);
  const agent = await buildAgent({ env: cfg.env, repos: cfg.repos, tracer });
  const chat = buildChatAdapter(cfg.env);

  const app = new Hono();
  app.get('/healthz', (c) =>
    c.json({ ok: true, model: cfg.env.FLUE_MODEL, provider: cfg.env.PROVIDER }),
  );
  app.get('/readyz', (c) => c.json({ ok: true, repos: cfg.repos.length }));

  app.route(
    '/',
    buildWebhookRoutes({
      webhookSecret: cfg.env.OPSSAGE_WEBHOOK_SECRET,
      alertChannel: cfg.env.OPSSAGE_ALERT_CHANNEL,
      agent,
      tracer,
      chat,
    }),
  );

  serve({ fetch: app.fetch, port: cfg.env.PORT }, (info) => {
    logger.info('opssage agent listening', {
      port: info.port,
      model: cfg.env.FLUE_MODEL,
      provider: cfg.env.PROVIDER,
    });
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      logger.info('shutting down', { sig });
      await tracer.flush();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error('fatal', { err: String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
