# OpsSage

Support / on-call agent built on [flue](https://github.com/withastro/flue).
First responder for Datadog alerts: pulls signals, reads code, posts a triage
summary in the alert's Slack thread before a human gets paged.

See [`AGENTS.md`](./AGENTS.md) for the philosophy and [`PLAN.md`](./PLAN.md)
for the v1 build plan. This README is the operator's quick-start.

## Layout

```
apps/agent      Hono webhook receiver + flue-shaped session loop
apps/sandbox    Tiny clone/grep RPC server (sibling ECS task)
packages/skills Vendored skill markdown + loader (diagnose-5xx-spike)
packages/tools  Datadog / GitHub / Slack / Langfuse wrappers
packages/config-schema  zod schemas for env, payloads, triage output
infra           AWS CDK app: VPC, secrets, ECS, observability
```

## Local dev

```sh
pnpm install
cp .env.example .env.local   # fill in Anthropic + DD + GitHub at minimum
pnpm dev                     # agent on :8080 with in-process sandbox
./scripts/fire-fixture.sh    # replay a fixture webhook
```

The agent defaults to `PROVIDER=anthropic` for local dev so you can run
without a Cursor key. Set `PROVIDER=cursor` + `CURSOR_API_KEY` to point at
Cursor's OpenAI-compatible endpoint instead.

## Quality gates

- `pnpm lint` — Biome (lint + format check)
- `pnpm typecheck` — TypeScript across the workspace
- `pnpm test` — Vitest across the workspace
- `pnpm ci` — `biome ci .` (what GitHub Actions runs)

A `simple-git-hooks` pre-commit hook runs `lint-staged` (Biome) on staged
files; pre-push runs typecheck + tests. After `pnpm install` they wire up
automatically via the `prepare` script.

## Deploy

CDK app lives under `infra/`. `cdk synth` runs in CI; `cdk deploy --all`
runs from the `deploy.yml` workflow on merges to `main`. Secrets are
created empty in `OpsSage-Secrets` — populate them out of band before the
first run.

## v1 in scope

- Datadog monitor webhook → `diagnose-5xx-spike` skill → Slack reply
- Single Anthropic/Cursor provider, single skill, single repo allowlist
- AWS Fargate (ALB + agent service + sandbox service)
- Langfuse tracing of every model + tool call

Out of scope (queued): Daytona, multi-tenant config, more skills,
GitHub App, multi-platform chat. See [`PLAN.md`](./PLAN.md) §"Out of
scope (v1) / queued".
