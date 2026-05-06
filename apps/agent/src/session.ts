import { datadog as ddTools, github as ghTools } from '@opssage/tools';
import type { langfuse as lf } from '@opssage/tools';
import {
  type DatadogWebhook,
  findRepoForService,
  type RepoAllowlist,
  tagsFromString,
  type TriageSummary,
  triageSummarySchema,
} from '@opssage/config-schema';
import { type Skill, selectSkill } from '@opssage/skills';
import { z } from 'zod';
import { logger } from './log.js';
import type { ChatMessage, ChatProvider, ToolDef } from './providers/cursor.js';
import type { SandboxClient } from './sandbox/client.js';

export interface SessionDeps {
  provider: ChatProvider;
  tracer: lf.LangfuseClient;
  datadog: ddTools.DatadogClient;
  github: ghTools.GithubClient;
  sandbox: SandboxClient;
  repos: RepoAllowlist;
  skills: Skill[];
}

const MAX_TURNS = 12;

/**
 * Run a single OpsSage triage session against a Datadog webhook payload.
 * Returns the parsed triage summary (or throws if the model never produced
 * one within MAX_TURNS).
 */
export async function runTriageSession(
  deps: SessionDeps,
  alert: DatadogWebhook,
  opts: { skillName: string; sessionId: string },
): Promise<TriageSummary> {
  const skill = selectSkill(deps.skills, opts.skillName);
  const traceId = deps.tracer.trace({
    name: `skill:${skill.name}`,
    input: alert,
    sessionId: opts.sessionId,
    tags: ['opssage', `skill:${skill.name}`],
    metadata: {
      monitor_id: alert.alert_id,
      aggregation_key: alert.aggregation_key,
      service: tagsFromString(alert.tags).service,
    },
  });

  const tools = buildToolDefs();
  const tagMap = tagsFromString(alert.tags);
  const seedRepo = tagMap.service ? findRepoForService(deps.repos, tagMap.service) : undefined;

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        '## Datadog alert payload',
        '```json',
        JSON.stringify(alert, null, 2),
        '```',
        '',
        seedRepo
          ? `Resolved repo from \`service:${tagMap.service}\` → \`${seedRepo.repo}\` (branch: \`${seedRepo.primary_branch}\`).`
          : 'No repo in the allowlist matches this alert; rely on Datadog signals only.',
        '',
        'Run the procedure now and emit the final JSON when done by calling the `emit_triage_summary` tool.',
      ].join('\n'),
    },
  ];

  let finalSummary: TriageSummary | undefined;

  for (let turn = 0; turn < MAX_TURNS && !finalSummary; turn++) {
    const span = deps.tracer.span({
      traceId,
      name: `turn-${turn}`,
      metadata: { turn },
    });
    let resp;
    try {
      resp = await deps.provider.chat({ system: skill.body, messages, tools });
    } catch (err) {
      deps.tracer.endSpan(span, { error: String(err) }, 'ERROR');
      throw err;
    }
    deps.tracer.generation({
      traceId,
      parentId: span.id,
      name: 'model',
      model: deps.provider.model,
      input: messages,
      output: { content: resp.content, tool_calls: resp.tool_calls },
      usage: resp.usage,
      metadata: { provider: deps.provider.providerName },
    });
    deps.tracer.endSpan(span, { tool_calls: resp.tool_calls.length });

    if (resp.tool_calls.length === 0) {
      // Model wants to talk; nudge it back to the contract.
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content:
          'You must finish by calling `emit_triage_summary` with the JSON. Continue executing the procedure or emit now.',
      });
      continue;
    }

    messages.push({
      role: 'assistant',
      content: resp.content,
      tool_calls: resp.tool_calls,
    });

    for (const call of resp.tool_calls) {
      if (call.name === 'emit_triage_summary') {
        const parsed = parseSummary(call.arguments);
        if (parsed) {
          finalSummary = parsed;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: 'OK',
          });
          break;
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: 'Invalid triage_summary JSON. Try again with valid fields.',
        });
        continue;
      }
      const toolSpan = deps.tracer.span({
        traceId,
        parentId: span.id,
        name: `tool:${call.name}`,
        metadata: { args: safeJson(call.arguments) },
      });
      try {
        const result = await runTool(deps, call.name, safeJson(call.arguments), opts.sessionId);
        deps.tracer.endSpan(toolSpan, result);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result).slice(0, 8000),
        });
      } catch (err) {
        deps.tracer.endSpan(toolSpan, { error: String(err) }, 'ERROR');
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ error: String(err) }),
        });
      }
    }
  }

  if (!finalSummary) {
    throw new Error(`triage session did not produce a summary in ${MAX_TURNS} turns`);
  }

  // Best-effort cleanup — sandbox state per session.
  await deps.sandbox.cleanup({ sessionId: opts.sessionId }).catch((err) => {
    logger.warn('sandbox cleanup failed', { err: String(err) });
  });

  return finalSummary;
}

function buildToolDefs(): ToolDef[] {
  return [
    {
      name: 'datadog_query_metrics',
      description: 'Run a Datadog metrics query for a window.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          fromSec: { type: 'number' },
          toSec: { type: 'number' },
        },
        required: ['query', 'fromSec', 'toSec'],
      },
    },
    {
      name: 'datadog_search_spans',
      description: 'Search APM spans matching a query within a time window.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          fromIso: { type: 'string' },
          toIso: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['query', 'fromIso', 'toIso'],
      },
    },
    {
      name: 'datadog_recent_deployments',
      description: 'List deployments for a service in a window.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string' },
          fromSec: { type: 'number' },
          toSec: { type: 'number' },
        },
        required: ['service', 'fromSec', 'toSec'],
      },
    },
    {
      name: 'github_search_code',
      description: 'Search code via the GitHub Search API. Use repo: qualifier to scope.',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' }, perPage: { type: 'integer' } },
        required: ['q'],
      },
    },
    {
      name: 'github_blame',
      description: 'Blame a file in repo at branch.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          branch: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['repo', 'branch', 'path'],
      },
    },
    {
      name: 'github_recent_pull_requests',
      description: 'List PRs in repo merged since the ISO timestamp.',
      parameters: {
        type: 'object',
        properties: { repo: { type: 'string' }, sinceIso: { type: 'string' } },
        required: ['repo', 'sinceIso'],
      },
    },
    {
      name: 'sandbox_clone',
      description: 'Shallow-clone a repo into the session sandbox.',
      parameters: {
        type: 'object',
        properties: { repo: { type: 'string' }, branch: { type: 'string' } },
        required: ['repo', 'branch'],
      },
    },
    {
      name: 'sandbox_grep',
      description: 'Ripgrep-style search inside the cloned sandbox workspace.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          maxResults: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'emit_triage_summary',
      description: 'Emit the final triage summary as the session result.',
      parameters: {
        type: 'object',
        properties: {
          hypothesis: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: {
                  type: 'string',
                  enum: ['datadog', 'github', 'sandbox', 'langfuse', 'other'],
                },
                summary: { type: 'string' },
                link: { type: 'string' },
              },
              required: ['source', 'summary'],
            },
          },
          suggested_next_step: { type: 'string' },
          linked_artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, url: { type: 'string' } },
              required: ['label', 'url'],
            },
          },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['hypothesis', 'evidence', 'suggested_next_step'],
      },
    },
  ];
}

const toolArgSchemas = {
  datadog_query_metrics: z.object({
    query: z.string(),
    fromSec: z.number(),
    toSec: z.number(),
  }),
  datadog_search_spans: z.object({
    query: z.string(),
    fromIso: z.string(),
    toIso: z.string(),
    limit: z.number().int().positive().max(100).default(20),
  }),
  datadog_recent_deployments: z.object({
    service: z.string(),
    fromSec: z.number(),
    toSec: z.number(),
  }),
  github_search_code: z.object({ q: z.string(), perPage: z.number().int().optional() }),
  github_blame: z.object({ repo: z.string(), branch: z.string(), path: z.string() }),
  github_recent_pull_requests: z.object({ repo: z.string(), sinceIso: z.string() }),
  sandbox_clone: z.object({ repo: z.string(), branch: z.string() }),
  sandbox_grep: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    maxResults: z.number().int().positive().max(200).default(50),
  }),
} as const;

async function runTool(
  deps: SessionDeps,
  name: string,
  rawArgs: unknown,
  sessionId: string,
): Promise<unknown> {
  switch (name) {
    case 'datadog_query_metrics': {
      const a = toolArgSchemas.datadog_query_metrics.parse(rawArgs);
      return await deps.datadog.queryMetrics(a.query, a.fromSec, a.toSec);
    }
    case 'datadog_search_spans': {
      const a = toolArgSchemas.datadog_search_spans.parse(rawArgs);
      return await deps.datadog.searchSpans({
        filter: { query: a.query, from: a.fromIso, to: a.toIso },
        page: { limit: a.limit },
      });
    }
    case 'datadog_recent_deployments': {
      const a = toolArgSchemas.datadog_recent_deployments.parse(rawArgs);
      return await deps.datadog.recentDeployments(a.service, a.fromSec, a.toSec);
    }
    case 'github_search_code': {
      const a = toolArgSchemas.github_search_code.parse(rawArgs);
      const opts = a.perPage !== undefined ? { perPage: a.perPage } : undefined;
      return await deps.github.searchCode(a.q, opts);
    }
    case 'github_blame': {
      const a = toolArgSchemas.github_blame.parse(rawArgs);
      requireRepoAllowed(deps, a.repo);
      return await deps.github.blame(a.repo, a.branch, a.path);
    }
    case 'github_recent_pull_requests': {
      const a = toolArgSchemas.github_recent_pull_requests.parse(rawArgs);
      requireRepoAllowed(deps, a.repo);
      return await deps.github.recentPullRequests(a.repo, a.sinceIso);
    }
    case 'sandbox_clone': {
      const a = toolArgSchemas.sandbox_clone.parse(rawArgs);
      requireRepoAllowed(deps, a.repo);
      return await deps.sandbox.clone({ sessionId, repo: a.repo, branch: a.branch });
    }
    case 'sandbox_grep': {
      const a = toolArgSchemas.sandbox_grep.parse(rawArgs);
      const args: Parameters<SandboxClient['grep']>[0] = {
        sessionId,
        pattern: a.pattern,
        maxResults: a.maxResults,
        ...(a.path !== undefined ? { path: a.path } : {}),
      };
      return await deps.sandbox.grep(args);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function requireRepoAllowed(deps: SessionDeps, repo: string): void {
  if (!deps.repos.some((r) => r.repo === repo)) {
    throw new Error(`repo "${repo}" is not in the allowlist`);
  }
}

function parseSummary(raw: string): TriageSummary | undefined {
  const json = safeJson(raw);
  const parsed = triageSummarySchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
