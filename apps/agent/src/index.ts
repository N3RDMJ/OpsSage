import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { datadog as ddTools, github as ghTools } from '@opssage/tools';
import { loadSkills } from '@opssage/skills';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './log.js';
import { buildProvider } from './providers/cursor.js';
import { buildTracer } from './tracing/langfuse.js';
import { buildSandboxClient } from './sandbox/client.js';
import { buildChatAdapter } from './chat/slack.js';
import { buildWebhookRoutes } from './webhook/datadog.js';

async function main() {
  const cfg = await loadConfig();
  setLogLevel(cfg.env.LOG_LEVEL);

  const tracer = buildTracer(cfg.env);
  const provider = buildProvider(cfg.env);
  const datadog = new ddTools.DatadogClient({
    apiKey: cfg.env.DATADOG_API_KEY,
    appKey: cfg.env.DATADOG_APP_KEY,
    site: cfg.env.DATADOG_SITE,
  });
  const github = new ghTools.GithubClient({ token: cfg.env.GITHUB_TOKEN });
  const sandbox = buildSandboxClient({
    mode: cfg.env.SANDBOX_MODE,
    url: cfg.env.SANDBOX_URL,
    githubToken: cfg.env.GITHUB_TOKEN,
  });
  const skills = await loadSkills();
  const chat = buildChatAdapter(cfg.env);

  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, provider: provider.providerName, model: provider.model }));
  app.get('/readyz', (c) =>
    c.json({ ok: true, skills: skills.map((s) => s.name), repos: cfg.repos.length }),
  );

  app.route(
    '/',
    buildWebhookRoutes({
      webhookSecret: cfg.env.OPSSAGE_WEBHOOK_SECRET,
      alertChannel: process.env.OPSSAGE_ALERT_CHANNEL ?? '#alerts',
      session: {
        provider,
        tracer,
        datadog,
        github,
        sandbox,
        repos: cfg.repos,
        skills,
      },
      tracer,
      chat,
    }),
  );

  const port = cfg.env.PORT;
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info('opssage agent listening', {
      port: info.port,
      provider: provider.providerName,
      model: provider.model,
      skills: skills.map((s) => s.name),
    });
  });

  // Graceful shutdown — flush any buffered traces.
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
