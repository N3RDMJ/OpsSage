# OpsSage

Support / on-call agent built on [flue](https://github.com/withastro/flue).
First responder for Datadog alerts: pulls signals, reads code, posts a triage
summary in the alert's Slack thread before a human gets paged.

See [`AGENTS.md`](./AGENTS.md) for the philosophy and [`PLAN.md`](./PLAN.md)
for the v1 build plan. This README is the operator's quick-start.

## Layout

```
apps/agent/.agents/skills    Markdown skills (flue's native discovery path)
apps/agent/src               Hono webhook receiver + flue agent bootstrap
packages/tools               Datadog / GitHub / Slack / Langfuse SDK wrappers
packages/config-schema       zod schemas for env, payloads, triage output
infra                        AWS CDK app: VPC, secrets, ECS, observability
```

## How it's wired to flue

```ts
const agent = await init({
  model: 'anthropic/claude-sonnet-4-6',
  providers: { anthropic: { baseUrl, apiKey } },  // anthropic OR cursor's compat endpoint
});
const session = await agent.session();
const result = await session.skill('diagnose-5xx-spike', {
  args: { alert, repos },
  commands: [gh, datadogCi, curl, rg, git, jq],   // shelled tools per AGENTS.md
});
```

- Skills live at `apps/agent/.agents/skills/*.md` — flue auto-discovers them.
- CLIs (`gh`, `datadog-ci`, `curl`, `git`, `rg`, `jq`) are baked into the
  agent's Docker image and registered with `defineCommand()`.
- Sandbox: flue's default virtual sandbox (just-bash inside the agent task)
  in prod; `FLUE_SANDBOX=local` mounts the host FS for dev.
- The webhook receiver, dedupe LRU, Slack adapter, and Langfuse tracer are
  thin glue around the flue agent — flue owns the session loop itself.

## Local dev

```sh
pnpm install
cp .env.example .env.local   # fill in Anthropic + DD + GitHub at minimum
pnpm dev                     # agent on :8080
./scripts/fire-fixture.sh    # replay a fixture webhook
```

Default `PROVIDER=anthropic` for local dev. Set `PROVIDER=cursor` +
`CURSOR_API_KEY` to route flue's anthropic provider at Cursor's
Anthropic-compatible endpoint instead.

## Quality gates

- `pnpm lint` — Biome (lint + format check)
- `pnpm typecheck` — TypeScript across the workspace
- `pnpm test` — Vitest
- `pnpm ci` — `biome ci .` (what GitHub Actions runs)

`simple-git-hooks` runs `lint-staged` (Biome) on staged files; pre-push runs
typecheck + tests. After `pnpm install` they wire up automatically via the
`prepare` script.

## Deploy

CDK app lives under `infra/`. `cdk synth` runs in CI; `cdk deploy --all` runs
from `deploy.yml` on merges to `main`. Secrets are created empty in
`OpsSage-Secrets` — populate them out of band before the first run.

## v1 in scope

- Datadog monitor webhook → flue session → `diagnose-5xx-spike` skill →
  Slack reply
- Anthropic-namespace model, transport-switchable to Cursor
- AWS Fargate (single agent service, ALB ingress restricted to Datadog IPs)
- Langfuse tracing around every flue session

Out of scope (queued): Daytona connector, multi-tenant config, more skills,
GitHub App, multi-platform chat. See [`PLAN.md`](./PLAN.md) §"Out of scope
(v1) / queued".
