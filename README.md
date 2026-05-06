# OpsSage

Support / on-call agent built on [flue](https://github.com/withastro/flue).
First responder for Datadog alerts: pulls signals, reads code, posts a triage
summary in the alert's Slack thread before a human gets paged.

See [`AGENTS.md`](./AGENTS.md) for the philosophy and [`PLAN.md`](./PLAN.md)
for the v1 build plan.

## Layout

```
apps/agent/.flue/agents/diagnose-5xx-spike.ts   The flue agent (default export)
apps/agent/.agents/skills/diagnose-5xx-spike.md Skill markdown (auto-discovered)
apps/agent/flue.config.ts                       flue project config
apps/agent/src/                                 Helpers the agent imports
                                                (dedupe, logger, slack adapter,
                                                 tracer wiring)
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
import type { FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';
import * as v from 'valibot';

export const triggers = { webhook: true };

const gh = defineCommand('gh', { env: { GH_TOKEN: process.env.GITHUB_TOKEN } });
// + datadog-ci, curl, rg, git, jq

export default async function ({ init, payload }: FlueContext) {
  // 1. verify Datadog secret + parse payload + dedupe
  const agent = await init({
    model: 'anthropic/claude-sonnet-4-6',
    providers: { anthropic: { baseUrl, apiKey } }, // anthropic OR cursor's compat endpoint
  });
  const session = await agent.session();
  const summary = await session.skill('diagnose-5xx-spike', {
    args: { alert, repos },
    commands: [gh, datadogCi, curl, rg, git, jq],
    result: triageResult, // valibot schema → typed structured output
  });
  // 2. post Slack reply, flush Langfuse
  return { status: 'ok', summary };
}
```

- `flue dev` runs the agent locally; `flue build --target node` produces the
  Node server we ship to ECS.
- Skill markdown lives at `.agents/skills/`; flue auto-discovers it.
- Tools are CLIs registered with `defineCommand()` and baked into the agent's
  Docker image.
- Result schema is Valibot (flue's native); zod stays for the webhook
  payload + repo allowlist (validation outside the model loop).

## Cursor-vs-Anthropic

Same flue model namespace (`anthropic/...`); set `PROVIDER=cursor` and a
`CURSOR_API_KEY` to point flue's anthropic provider at Cursor's
Anthropic-compatible endpoint. No code change.

## Local dev

```sh
pnpm install
cp .env.example apps/agent/.env.local   # fill in Anthropic + DD + GitHub at minimum
pnpm dev                                 # = flue dev on :8080
./scripts/fire-fixture.sh                # replay a fixture webhook
```

## Quality gates

- `pnpm lint` — Biome
- `pnpm typecheck` — TypeScript
- `pnpm test` — Vitest
- `pnpm ci` — `biome ci .` (what GitHub Actions runs)

`simple-git-hooks` runs `lint-staged` (Biome) on staged files; pre-push runs
typecheck + tests.

## Deploy

CDK app under `infra/`. `cdk synth` runs in CI; `cdk deploy --all` runs from
`deploy.yml` on merges to `main`. Secrets land empty in `OpsSage-Secrets` —
populate them out of band before the first run.

## v1 in scope

- Datadog monitor webhook → flue agent → `diagnose-5xx-spike` skill →
  Slack reply
- Anthropic-namespace model, transport-switchable to Cursor
- Single Fargate task behind ALB (Datadog IP allowlist)
- Langfuse tracing around every flue session

Out of scope (queued): Daytona connector, multi-tenant config, more skills,
GitHub App, multi-platform chat. See [`PLAN.md`](./PLAN.md) §"Out of scope
(v1) / queued".
