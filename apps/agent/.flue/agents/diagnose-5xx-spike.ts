import { timingSafeEqual } from 'node:crypto';
import { type FlueContext } from '@flue/sdk';
import { defineCommand } from '@flue/sdk/node';
import {
  datadogWebhookSchema,
  dedupeKey,
  loadRepoAllowlist,
  parseEnv,
} from '@opssage/config-schema';
import { langfuse } from '@opssage/tools';
import * as v from 'valibot';
import { buildChatAdapter, renderSummary } from '../lib/chat.js';
import { TtlLru } from '../lib/dedupe.js';
import { logger } from '../lib/log.js';

// Trigger: Datadog calls POST /agents/diagnose-5xx-spike with the webhook
// JSON as the body. flue's webhook trigger surfaces it as `payload`.
export const triggers = { webhook: true };

const env = parseEnv(process.env);

// Module-level dedupe — single Fargate task, 5-min window, matches PLAN.md.
// If we ever scale to >1 replica we move this to Redis.
const recentEvents = new TtlLru<string, true>(500, 5 * 60_000);

// Tools the skill is allowed to shell out to. The agent container ships
// these binaries (apps/agent/Dockerfile).
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

// Valibot schema for `result:` — flue uses Standard Schema, validates the
// model's structured output before returning.
const triageResult = v.object({
  hypothesis: v.string(),
  evidence: v.array(
    v.object({
      source: v.picklist(['datadog', 'github', 'sandbox', 'langfuse', 'other']),
      summary: v.string(),
      link: v.optional(v.string()),
    }),
  ),
  suggested_next_step: v.string(),
  linked_artifacts: v.optional(
    v.array(v.object({ label: v.string(), url: v.string() })),
    [],
  ),
  confidence: v.picklist(['low', 'medium', 'high']),
});

type TriageResult = v.InferOutput<typeof triageResult>;

export default async function diagnose5xxSpike(ctx: FlueContext) {
  // 1. Authenticate the webhook. Datadog sets a custom header; flue's
  // FlueContext exposes the inbound headers (we read defensively and fall
  // back to env-injected variants if shape differs).
  const provided = readHeader(ctx, 'x-opssage-secret');
  if (!constantTimeEqual(provided, env.OPSSAGE_WEBHOOK_SECRET)) {
    logger.warn('datadog webhook rejected: bad secret');
    return responseError(401, 'unauthorized');
  }

  // 2. Validate the payload.
  const parsed = datadogWebhookSchema.safeParse(ctx.payload);
  if (!parsed.success) {
    logger.warn('datadog webhook rejected: schema', { issues: parsed.error.issues });
    return responseError(400, 'invalid_payload');
  }
  const alert = parsed.data;

  // 3. Dedupe transitions on aggregation_key.
  const key = dedupeKey(alert);
  if (recentEvents.has(key)) {
    return { status: 'duplicate', key };
  }
  recentEvents.set(key, true);

  const sessionId = `${key}-${Date.now().toString(36)}`;
  logger.info('webhook accepted', {
    sessionId,
    alert_id: alert.alert_id,
    transition: alert.alert_transition,
  });

  // 4. Bootstrap flue + Langfuse tracing.
  const repos = await loadRepoAllowlist(env.OPSSAGE_REPOS_FILE);
  const tracer = new langfuse.LangfuseClient({
    publicKey: env.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: env.LANGFUSE_SECRET_KEY ?? '',
    host: env.LANGFUSE_HOST,
  });
  const traceId = tracer.trace({
    name: 'skill:diagnose-5xx-spike',
    input: alert,
    sessionId,
    tags: ['opssage', 'skill:diagnose-5xx-spike'],
    metadata: { alert_id: alert.alert_id, aggregation_key: alert.aggregation_key },
  });
  const span = tracer.span({ traceId, name: 'session.skill' });

  let summary: TriageResult;
  try {
    const agent = await ctx.init({
      model: env.FLUE_MODEL,
      // Default sandbox is virtual (just-bash); FLUE_SANDBOX=local mounts host FS.
      ...(env.FLUE_SANDBOX ? { sandbox: env.FLUE_SANDBOX } : {}),
      providers: buildProviderConfig(),
    });
    const session = await agent.session();

    summary = await session.skill('diagnose-5xx-spike', {
      args: { alert, repos },
      commands: [gh, datadogCi, curl, rg, git, jq],
      result: triageResult,
    });
    tracer.endSpan(span, summary);
  } catch (err) {
    tracer.endSpan(span, { error: String(err) }, 'ERROR');
    logger.error('triage failed', { sessionId, err: String(err) });
    await tracer.flush();
    return responseError(500, 'triage_failed');
  }

  // 5. Reply in the Datadog→Slack alert thread.
  try {
    const chat = buildChatAdapter(env);
    const target = alert.alert_url
      ? await chat.locateAlertThread({
          channel: env.OPSSAGE_ALERT_CHANNEL,
          alertUrl: alert.alert_url,
        })
      : undefined;
    await chat.reply({
      target: target ?? { channel: env.OPSSAGE_ALERT_CHANNEL },
      summary: { ...summary, linked_artifacts: summary.linked_artifacts ?? [] },
      ...(alert.alert_url !== undefined ? { alertUrl: alert.alert_url } : {}),
    });
  } catch (err) {
    logger.warn('slack reply failed', { sessionId, err: String(err) });
  }

  await tracer.flush();
  logger.info('triage complete', { sessionId, hypothesis: summary.hypothesis });

  return {
    status: 'ok',
    sessionId,
    summary,
    slack_markdown: renderSummary(
      { ...summary, linked_artifacts: summary.linked_artifacts ?? [] },
      alert.alert_url,
    ),
  };
}

function buildProviderConfig() {
  if (env.PROVIDER === 'cursor') {
    if (!env.CURSOR_API_KEY) throw new Error('PROVIDER=cursor but CURSOR_API_KEY is unset');
    return { anthropic: { baseUrl: env.CURSOR_BASE_URL, apiKey: env.CURSOR_API_KEY } };
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('PROVIDER=anthropic but ANTHROPIC_API_KEY is unset');
  }
  return { anthropic: { apiKey: env.ANTHROPIC_API_KEY } };
}

function readHeader(ctx: FlueContext, name: string): string {
  // FlueContext header surface isn't fully documented across runtimes —
  // Cloudflare uses Request, Node may surface a plain object. Try the
  // common shapes.
  // biome-ignore lint/suspicious/noExplicitAny: traversing untyped runtime context
  const anyCtx = ctx as any;
  const direct = anyCtx.headers?.[name] ?? anyCtx.headers?.[name.toLowerCase()];
  if (typeof direct === 'string') return direct;
  if (typeof anyCtx.request?.headers?.get === 'function') {
    return anyCtx.request.headers.get(name) ?? '';
  }
  if (anyCtx.request?.headers && typeof anyCtx.request.headers === 'object') {
    return (anyCtx.request.headers[name] ?? anyCtx.request.headers[name.toLowerCase()] ?? '') as string;
  }
  return '';
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function responseError(status: number, code: string) {
  return { status, error: code };
}
