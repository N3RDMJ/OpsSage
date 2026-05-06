import { defineCommand, init } from '@flue/sdk/node';
import {
  type DatadogWebhook,
  type Env,
  type RepoAllowlist,
  type TriageSummary,
  triageSummarySchema,
} from '@opssage/config-schema';
import type { langfuse as lf } from '@opssage/tools';
import { logger } from './log.js';

/**
 * One flue agent is bootstrapped at process start; each webhook spawns a
 * session against it. The skill markdown lives at `.agents/skills/` and is
 * auto-discovered by flue from the working directory.
 */
export interface OpsSageAgent {
  triage(input: { alert: DatadogWebhook; sessionId: string }): Promise<TriageSummary>;
}

export interface BuildAgentDeps {
  env: Env;
  repos: RepoAllowlist;
  tracer: lf.LangfuseClient;
}

export async function buildAgent(deps: BuildAgentDeps): Promise<OpsSageAgent> {
  const { env, repos, tracer } = deps;

  const providers = buildProviderConfig(env);

  // Tools the skill is allowed to shell out to. flue's virtual sandbox runs
  // these inside a just-bash environment; the agent container ships the
  // binaries (see apps/agent/Dockerfile).
  const gh = defineCommand('gh', { env: { GH_TOKEN: env.GITHUB_TOKEN } });
  const datadogCi = defineCommand('datadog-ci', {
    env: {
      DATADOG_API_KEY: env.DATADOG_API_KEY,
      DATADOG_APP_KEY: env.DATADOG_APP_KEY,
      DATADOG_SITE: env.DATADOG_SITE,
    },
  });
  const curl = defineCommand('curl', {
    env: {
      DD_API_KEY: env.DATADOG_API_KEY,
      DD_APP_KEY: env.DATADOG_APP_KEY,
    },
  });
  const rg = defineCommand('rg');
  const git = defineCommand('git', {
    env: { GH_TOKEN: env.GITHUB_TOKEN, GIT_TERMINAL_PROMPT: '0' },
  });
  const jq = defineCommand('jq');

  const agent = await init({
    model: env.FLUE_MODEL,
    sandbox: env.FLUE_SANDBOX, // 'local' | undefined (= virtual just-bash default)
    providers,
  });

  return {
    async triage({ alert, sessionId }) {
      const traceId = tracer.trace({
        name: 'skill:diagnose-5xx-spike',
        input: alert,
        sessionId,
        tags: ['opssage', 'skill:diagnose-5xx-spike'],
        metadata: {
          monitor_id: alert.alert_id,
          aggregation_key: alert.aggregation_key,
        },
      });
      const span = tracer.span({ traceId, name: 'session.skill' });

      try {
        const session = await agent.session();
        const raw = await session.skill('diagnose-5xx-spike', {
          args: {
            alert,
            repos,
          },
          commands: [gh, datadogCi, curl, rg, git, jq],
        });
        const summary = parseTriage(raw);
        tracer.endSpan(span, summary);
        return summary;
      } catch (err) {
        tracer.endSpan(span, { error: String(err) }, 'ERROR');
        throw err;
      } finally {
        await tracer.flush();
      }
    },
  };
}

function buildProviderConfig(env: Env): Record<string, ProviderConfig> {
  // The plan's open question — "which flue provider module wires Cursor" —
  // resolves cleanly: Cursor exposes an Anthropic-compatible endpoint, and
  // flue lets us point its anthropic provider at any baseUrl. Same model
  // namespace, swap the transport.
  if (env.PROVIDER === 'cursor') {
    if (!env.CURSOR_API_KEY) throw new Error('PROVIDER=cursor but CURSOR_API_KEY is unset');
    return {
      anthropic: {
        baseUrl: env.CURSOR_BASE_URL,
        apiKey: env.CURSOR_API_KEY,
      },
    };
  }
  if (!env.ANTHROPIC_API_KEY) throw new Error('PROVIDER=anthropic but ANTHROPIC_API_KEY is unset');
  return {
    anthropic: { apiKey: env.ANTHROPIC_API_KEY },
  };
}

interface ProviderConfig {
  baseUrl?: string;
  apiKey: string;
  headers?: Record<string, string>;
}

/**
 * The skill instructs the agent to emit a JSON object matching
 * `triageSummarySchema`. flue returns the assistant's final text when no
 * `result:` schema is provided; we extract the JSON block and validate it
 * with our zod schema (kept canonical so the rest of the codebase stays in
 * one schema language).
 */
function parseTriage(raw: unknown): TriageSummary {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const candidate = extractJsonBlock(text) ?? text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    logger.error('triage parse failed', { err: String(err), preview: text.slice(0, 200) });
    throw new Error('skill did not return valid JSON');
  }
  return triageSummarySchema.parse(parsed);
}

function extractJsonBlock(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (fenced?.[1]) return fenced[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return undefined;
}
