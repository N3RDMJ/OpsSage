# OpsSage

Support / on-call agent built on [flue](https://github.com/withastro/flue).
First responder for Datadog alerts: pulls signals, reads code, posts a triage
summary in the alert's Slack thread before a human gets paged.

See [`AGENTS.md`](./AGENTS.md) for the philosophy and [`PLAN.md`](./PLAN.md)
for the v1 build plan.

## Layout

```
apps/agent/.flue/agents/diagnose-5xx-spike.ts   The flue agent (default export)
apps/agent/.flue/lib/                           Helpers the agent imports
                                                (dedupe, logger, slack adapter)
apps/agent/.agents/skills/diagnose-5xx-spike.md Skill markdown (auto-discovered)
packages/tools                                  Datadog / GitHub / Slack /
                                                Langfuse SDK wrappers
packages/config-schema                          zod schemas (env, payloads,
                                                triage output)
infra                                           AWS CDK app (VPC, secrets,
                                                ECS, observability)
```

## How it's wired to flue

The agent file is a flue agent — flue is the runtime, not a library called
from a separate HTTP server:

```ts
// apps/agent/.flue/agents/diagnose-5xx-spike.ts
import type { FlueContext } from '@flue/sdk';
import { defineCommand } from '@flue/sdk/node';
import * as v from 'valibot';

export const triggers = { webhook: true };

const gh = defineCommand('gh', { env: { GH_TOKEN: process.env.GITHUB_TOKEN } });
// + datadog-ci, curl, rg, git, jq

export default async function ({ init, payload }: FlueContext) {
  // 1. verify Datadog secret + parse payload + dedupe
  const session = await init({
    sandbox: 'local',                       // mounts cwd at /workspace
    model: 'anthropic/claude-sonnet-4-6',   // pi-ai resolves keys from env
  });
  const summary = await session.skill('diagnose-5xx-spike', {
    args: { alert, repos },
    commands: [gh, datadogCi, curl, rg, git, jq],
    result: triageSchema,                   // valibot → typed structured output
  });
  // 2. post Slack reply, flush Langfuse
  return { status: 'ok', summary };
}
```

- `flue dev` runs the agent locally; `flue build --target node` produces
  `dist/server.mjs`, the Node server we ship to ECS. The runtime exposes
  `GET /health`, `GET /agents` (manifest), and `POST /agents/<name>/<id>`.
- Skill markdown lives at `.agents/skills/`; flue auto-discovers it.
- Tools are CLIs registered with `defineCommand()` and baked into the agent's
  Docker image.
- Result schema is Valibot (flue's native); zod stays for the webhook
  payload + repo allowlist (validation outside the model loop).

## Auth

`FlueContext` exposes only `{ sessionId, payload, env, init }` — no
request headers. The webhook secret CAN'T be validated inside the agent
function. v1 leans on the ALB security group, which restricts ingress to
Datadog's published webhook IP ranges (refreshed daily by the
`DatadogIpRanges` custom resource in `infra/`). Add a Lambda authorizer
or path-embedded token if/when belt-and-suspenders is needed.

## Why not Cursor as the model provider

The original plan named Cursor as the LLM target. After looking at what
Cursor actually ships, that doesn't fit:

- The [Cursor APIs](https://cursor.com/docs/api) are Admin, Analytics,
  AI Code Tracking, **Cloud Agents**, and a TypeScript SDK. There's
  no `/v1/messages` or `/v1/chat/completions` endpoint to point flue's
  model layer at.
- [`@cursor/sdk`](https://cursor.com/blog/typescript-sdk) is a coding-
  agent runtime — `Agent.create({ apiKey, model: { id: 'composer-2' },
  local: { cwd } })` then `agent.send(prompt)`. It's structurally
  parallel to flue, not stackable; adopting it would mean replacing
  flue, not extending it.
- pi-ai (flue's provider library) ships zero Cursor support, and there's
  nothing for it to support — pi-ai is a completions-style provider
  layer; Cursor isn't a completions-style service.

So v1 ships with Anthropic via pi-ai, which is real raw inference
(`https://api.anthropic.com/v1/messages` with `ANTHROPIC_API_KEY`). If
Cursor's models become useful for deep code investigation, the right
shape is "Cursor SDK as a tool the skill invokes" — alongside `gh`,
`datadog-ci`, etc. — not as the LLM provider.

## Local dev

```sh
pnpm install
cp .env.example apps/agent/.env.local   # fill in Anthropic + DD + GitHub at minimum
pnpm dev                                 # = flue dev on :8080
./scripts/fire-fixture.sh                # replay a fixture webhook
```

## Quality gates

- `pnpm lint` — Biome (`biome check`)
- `pnpm typecheck` — TypeScript
- `pnpm test` — Vitest
- `pnpm check` — `biome ci .` (what GitHub Actions runs)

`simple-git-hooks` runs `lint-staged` (Biome) on staged files; pre-push runs
typecheck + tests.

## Deploy

CDK app under `infra/`. `cdk synth` runs in CI; `cdk deploy --all` runs from
`deploy.yml` on merges to `main`. Secrets land empty in `OpsSage-Secrets` —
populate them out of band before the first run.

## v1 in scope

- Datadog monitor webhook → flue agent → `diagnose-5xx-spike` skill →
  Slack reply
- Anthropic via pi-ai (any pi-ai built-in provider is a one-line swap)
- Single Fargate task behind ALB (Datadog IP allowlist)
- Langfuse tracing around every flue session

Out of scope (queued): Daytona connector, multi-tenant config, more skills,
GitHub App, multi-platform chat. See [`PLAN.md`](./PLAN.md) §"Out of scope
(v1) / queued".
