import type { FlueContext } from '@flue/sdk';
import { defineCommand } from '@flue/sdk/node';
import {
  type RepoAllowlist,
  datadogWebhookSchema,
  dedupeKey,
  loadRepoAllowlist,
  parseEnv,
} from '@opssage/config-schema';
import { langfuse } from '@opssage/tools';
import { buildChatAdapter } from '../lib/chat.js';
import { TtlLru } from '../lib/dedupe.js';
import { logger, setLogLevel } from '../lib/log.js';
import { type TriageSummary, triageSchema } from '../lib/triage-schema.js';

// Webhook trigger ⇒ flue exposes this agent at POST /agents/diagnose-5xx-spike/:sessionId
// and ack's 202 immediately if the caller sends `x-webhook: true`.
export const triggers = { webhook: true };

// --- module init: runs once per process startup ----------------------------

const env = parseEnv(process.env);
setLogLevel(env.LOG_LEVEL);

// Auth note: flue's FlueContext intentionally exposes only { sessionId,
// payload, env, init } — no inbound headers (verified in the SDK source).
// Webhook authentication therefore has to live at the network edge: the ALB
// security group already restricts ingress to Datadog's webhook IP ranges
// (see infra/lib/datadog-ip-ranges.ts), and we run on HTTPS. The shared
// secret env var stays in the schema so we can switch to a Lambda
// authorizer or path-embedded token later without an env-shape change.

// Load static config once. flue invokes the default export for every
// request; doing this work per-request would mean a filesystem read on
// every Datadog alert.
const reposPromise: Promise<RepoAllowlist> = loadRepoAllowlist(env.OPSSAGE_REPOS_FILE).catch(
  (err) => {
    logger.error('failed to load repo allowlist', { err: String(err) });
    return [];
  },
);

const tracer = new langfuse.LangfuseClient({
  publicKey: env.LANGFUSE_PUBLIC_KEY ?? '',
  secretKey: env.LANGFUSE_SECRET_KEY ?? '',
  host: env.LANGFUSE_HOST,
});

const chat = buildChatAdapter(env);

// Single Fargate task, 5-min window. Multi-replica → swap for Redis.
const recentEvents = new TtlLru<string, true>(500, 5 * 60_000);

// CLIs the skill is allowed to shell out to. Available because we set
// `sandbox: 'local'` below (mounts process.cwd() at /workspace inside the
// just-bash isolate); the agent container ships every binary listed here.
const gh = defineCommand('gh', { env: { GH_TOKEN: env.GITHUB_TOKEN } });
const datadogCi = defineCommand('datadog-ci', {
  env: {
    DATADOG_API_KEY: env.DATADOG_API_KEY,
    DATADOG_APP_KEY: env.DATADOG_APP_KEY,
    DATADOG_SITE: env.DATADOG_SITE,
  },
});
const curl = defineCommand('curl', {
  env: { DD_API_KEY: env.DATADOG_API_KEY, DD_APP_KEY: env.DATADOG_APP_KEY },
});
const rg = defineCommand('rg');
const git = defineCommand('git', {
  env: { GH_TOKEN: env.GITHUB_TOKEN, GIT_TERMINAL_PROMPT: '0' },
});
const jq = defineCommand('jq');

// --- agent handler ---------------------------------------------------------

export default async function diagnose5xxSpike(ctx: FlueContext) {
  const parsed = datadogWebhookSchema.safeParse(ctx.payload);
  if (!parsed.success) {
    logger.warn('payload rejected: schema', { issues: parsed.error.issues });
    return { status: 'invalid_payload', issues: parsed.error.issues };
  }
  const alert = parsed.data;

  const key = dedupeKey(alert);
  if (recentEvents.has(key)) {
    return { status: 'duplicate', key };
  }
  recentEvents.set(key, true);

  const sessionId = ctx.sessionId;
  logger.info('webhook accepted', {
    sessionId,
    alert_id: alert.alert_id,
    transition: alert.alert_transition,
  });

  const repos = await reposPromise;
  const traceId = tracer.trace({
    name: 'skill:diagnose-5xx-spike',
    input: alert,
    sessionId,
    tags: ['opssage', 'skill:diagnose-5xx-spike'],
    metadata: { alert_id: alert.alert_id, aggregation_key: alert.aggregation_key },
  });
  const span = tracer.span({ traceId, name: 'session.skill', metadata: { sessionId } });

  let summary: TriageSummary;
  try {
    // `init()` returns FlueSession directly — there is no `agent.session()`
    // step. Provider config (API keys, base URLs) is env-driven via pi-ai;
    // see ANTHROPIC_API_KEY in the task env.
    const session = await ctx.init({
      // 'local' mounts process.cwd() at /workspace so commands have host
      // access. The default 'empty' would block gh/git/curl/rg/datadog-ci.
      sandbox: 'local',
      model: env.FLUE_MODEL,
    });

    summary = await session.skill('diagnose-5xx-spike', {
      args: { alert, repos },
      commands: [gh, datadogCi, curl, rg, git, jq],
      result: triageSchema,
    });
    tracer.endSpan(span, summary);
  } catch (err) {
    tracer.endSpan(span, { error: String(err) }, 'ERROR');
    logger.error('triage failed', { sessionId, err: String(err) });
    await tracer.flush();
    return { status: 'triage_failed', error: String(err) };
  }

  try {
    const target = alert.alert_url
      ? await chat.locateAlertThread({
          channel: env.OPSSAGE_ALERT_CHANNEL,
          alertUrl: alert.alert_url,
        })
      : undefined;
    await chat.reply({
      target: target ?? { channel: env.OPSSAGE_ALERT_CHANNEL },
      summary,
      ...(alert.alert_url !== undefined ? { alertUrl: alert.alert_url } : {}),
    });
  } catch (err) {
    logger.warn('slack reply failed', { sessionId, err: String(err) });
  }

  await tracer.flush();
  logger.info('triage complete', { sessionId, hypothesis: summary.hypothesis });

  return { status: 'ok', sessionId, summary };
}
