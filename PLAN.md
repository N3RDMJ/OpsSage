# OpsSage — Implementation Plan

Companion to [`AGENTS.md`](./AGENTS.md). This document captures the v1 build:
what we ship, in what shape, in what order, and which questions remain open.

## v1 in one paragraph

A flue-based agent that listens for **Datadog monitor webhooks**, runs the
**`diagnose-5xx-spike`** skill against **Datadog + GitHub** (a configured
allowlist of repos), and posts a **triage summary** as a reply in the
existing Datadog→Slack alert thread (plus structured JSON to stdout).
Deployed to **AWS ECS Fargate** behind an ALB, secrets in **AWS Secrets
Manager**, infra in **AWS CDK (TypeScript)**, every run traced through
**Langfuse**. Model provider is **Cursor** via flue's provider layer.

Out of scope for v1: other skills, multi-tenant config, Daytona, Teams/
Discord output, skill registry, GitHub App.

## Architecture

```
 Datadog monitor
        │  (webhook: POST /v1/events/datadog)
        ▼
 ┌────────────────────────┐       ┌─────────────────────┐
 │ ALB (HTTPS, IP allow-  │──────▶│ Agent task (Fargate)│
 │  list of DD ranges)    │       │  • webhook receiver │
 └────────────────────────┘       │  • flue session     │
                                  │  • chat-sdk.dev     │
                                  │  • langfuse tracer  │
                                  └─────┬───────┬───────┘
                                        │       │
                       Datadog API/curl │       │ ecs:RunTask / RPC
                       gh CLI + GH API  │       ▼
                       Cursor (LLM)     │  ┌──────────────────┐
                       Langfuse traces  │  │ Sandbox task     │
                                        │  │ (sibling ECS,    │
                                        │  │  shallow clones, │
                                        │  │  grep/static)    │
                                        │  └──────────────────┘
                                        ▼
                                  Slack (chat-sdk.dev → Slack adapter)
                                  reply-in-thread on the DD alert message
```

## Repo layout (pnpm workspace)

```
opssage/
├── AGENTS.md                      # framework / philosophy (existing)
├── PLAN.md                        # this file
├── pnpm-workspace.yaml
├── package.json                   # root, private
├── tsconfig.base.json
├── apps/
│   ├── agent/                     # the running service
│   │   ├── src/
│   │   │   ├── index.ts           # HTTP server (Hono/fastify) + flue bootstrap
│   │   │   ├── webhook/datadog.ts # header-secret verify + payload parse
│   │   │   ├── chat/              # chat-sdk.dev wiring + Slack adapter
│   │   │   ├── providers/cursor.ts
│   │   │   ├── tracing/langfuse.ts
│   │   │   ├── sandbox/client.ts  # talks to the sandbox task
│   │   │   └── config.ts
│   │   └── Dockerfile
│   └── sandbox/                   # long-running clone/grep helper
│       ├── src/index.ts           # tiny RPC server: clone, ls, grep, blame
│       └── Dockerfile             # has git, ripgrep, gh, jq
├── packages/
│   ├── skills/                    # vendored flue skills
│   │   └── diagnose-5xx-spike.md
│   ├── tools/                     # shared TS wrappers around CLIs/APIs
│   │   └── src/{datadog,github,langfuse,slack}.ts
│   └── config-schema/             # zod schemas for env + repo allowlist
└── infra/                         # AWS CDK app
    ├── bin/opssage.ts
    └── lib/{network,ecs,secrets,observability}-stack.ts
```

## Components

### 1. Webhook receiver (`apps/agent`)

- Single HTTP server (Hono — small, edge-friendly, fine on Node).
- Route `POST /v1/events/datadog`:
  1. Verify `X-OpsSage-Secret` header against value from Secrets Manager.
  2. Parse Datadog's payload (`$EVENT_TYPE`, `$ALERT_ID`, `$AGGREG_KEY`,
     `$LINK`, tags, etc.) — schema validated with zod.
  3. Idempotency: dedupe on `aggregation_key + state_transition` for
     5 min (in-memory LRU is fine for v1; one task only).
  4. Spawn a flue session, hand it the parsed alert as the seed input.
- Health check `GET /healthz` for the ALB.

### 2. flue session

- One session per alert. Roles + tools wired up at startup.
- Provider: Cursor via `@flue/provider-cursor` (or whatever flue ships;
  TBD on exact module name — fall through to Anthropic if Cursor is
  unavailable in dev).
- Skills loaded from `packages/skills/*.md` at boot; flue's native skill
  loader does this — no plugin layer.
- Tools the agent has shell access to:
  - `curl` + helpers around the Datadog API (metrics, logs, monitors,
    APM, deployments).
  - `gh` CLI (auth via Classic PAT, read-only) for repo/PR/issue/search.
  - `datadog-ci` for CI visibility / synthetics / deployments where it
    covers the operation cleanly.
  - A small `opssage-sandbox` shim that talks to the sandbox task.

### 3. Sandbox task (`apps/sandbox`)

- Sibling ECS Fargate **service** (1 task, 0.5 vCPU / 1 GiB) sitting on
  the agent's private subnet, reachable over Cloud Map DNS.
- Decision: **service, not RunTask-per-request.** A pool-of-1 keeps cold
  starts off the triage critical path; cleanup is per-session, not
  per-task. We can move to RunTask later if isolation needs grow.
- Exposes a tiny JSON-over-HTTP RPC: `clone`, `grep`, `blame`, `ls`,
  `stat`, `cleanup`. Each call works against `/work/<sessionId>/` and
  cleanup wipes that subdirectory.
- Image has `git`, `ripgrep`, `gh`, `jq`, nothing else. Outbound network
  restricted via SG to GitHub + Datadog ranges.
- IAM: no AWS permissions beyond pulling its own image + writing logs.

### 4. Skill: `diagnose-5xx-spike`

A single markdown file under `packages/skills/`. Roughly:

```
---
name: diagnose-5xx-spike
trigger: monitor alert, query references "http.5xx" or tag service:*
---

You are OpsSage. A 5xx spike alert just fired. Produce a triage summary:

1. Pull the monitor's query and replay it for the last 60 minutes
   (curl Datadog metrics API).
2. List the top failing routes from APM traces in the same window.
3. List deploys to the affected service in the last 2 hours
   (`datadog-ci deployments` or the events API).
4. For the top error route, find the file/function in the configured
   repo (allowlist), then `gh blame` the most recently modified lines.
5. Output: { hypothesis, evidence[], suggested_next_step,
   linked_artifacts[] } as JSON, and a markdown rendering for Slack.
```

(The actual skill grows over time; this is the v1 skeleton.)

### 5. Slack delivery (chat-sdk.dev)

- Use [`chat-sdk.dev`](https://chat-sdk.dev) — TypeScript SDK with
  Slack/Teams/Discord/etc. adapters, threads, JSX cards, slash commands.
- v1 surface: Slack adapter only.
- Datadog→Slack official integration already posts the alert. We
  correlate via the Datadog event's `link`/`alert_id` (Datadog's Slack
  message contains the alert URL) — chat-sdk's `search_threads` /
  subscribed-message events let us find the message and `add_reply` in
  thread.
- Same agent later supports a slash command (`/opssage explain <link>`)
  for manual invocation; design now, ship after webhook flow works.

### 6. Tracing (Langfuse)

- Wrap the flue session: every prompt, tool call, model response is one
  observation; the whole alert→summary cycle is one trace; tags include
  `monitor_id`, `service`, `aggregation_key`.
- Langfuse public+secret keys in Secrets Manager.
- This dogfoods the `explain-langfuse-regression` skill we ship in v2.

## AWS infrastructure (CDK)

Single CDK app, four stacks:

1. **NetworkStack** — VPC (2 AZs, public + private subnets, single NAT
   for cost), Cloud Map namespace `opssage.local`.
2. **SecretsStack** — Secrets Manager entries for: Cursor key, Datadog
   API key + app key, GitHub PAT, Slack bot token + signing secret,
   Langfuse keys, OpsSage webhook shared secret. One JSON per logical
   group.
3. **EcsStack** —
   - ECR repos for `agent` and `sandbox` images.
   - ECS cluster (Fargate).
   - **Agent service**: 1 task, 1 vCPU / 2 GiB, behind an internet-facing
     ALB on HTTPS (ACM cert), target group on `/healthz`. Task role gets
     read on the relevant secrets, `ecs:DescribeTasks` for the sandbox,
     and CloudWatch Logs.
   - **Sandbox service**: 1 task, internal-only, registered in Cloud Map
     as `sandbox.opssage.local`. Egress SG limited to GitHub + Datadog
     CIDRs.
   - **ALB SG**: ingress 443 from Datadog's published webhook IP ranges
     **only** — fetched at deploy time by a small Lambda-backed custom
     resource that pulls `https://ip-ranges.datadoghq.com/` and rebuilds
     the SG. Re-runs daily via EventBridge to track range changes.
4. **ObservabilityStack** — CloudWatch log groups + a couple of metric
   filters (5xx on `/v1/events/*`, parse failures), no dashboards yet.

## Secrets (single source of truth = Secrets Manager)

| Secret name                  | Contents                                                     |
| ---------------------------- | ------------------------------------------------------------ |
| `opssage/webhook`            | `{ datadog_shared_secret }`                                  |
| `opssage/datadog`            | `{ api_key, app_key, site }`                                 |
| `opssage/github`             | `{ pat }` (classic, read-only: repo, read:org)               |
| `opssage/slack`              | `{ bot_token, signing_secret, app_id }`                      |
| `opssage/cursor`             | `{ api_key }`                                                |
| `opssage/langfuse`           | `{ public_key, secret_key, host }`                           |

ECS task definition pulls these via `secrets:` blocks; nothing in env
plaintext. Local dev reads from `.env.local` (gitignored).

## Webhook auth

Datadog webhooks support arbitrary `custom_headers`; the most common
pattern (and what we'll use) is **shared secret in a custom header** +
**source IP allowlist** at the ALB SG. Full breakdown:

- Configure the Datadog webhook with custom header
  `X-OpsSage-Secret: <random 32 byte token>`.
- Agent rejects requests where the header is missing or doesn't match
  (constant-time compare).
- ALB SG only accepts inbound 443 from Datadog's published webhook IPs
  (refreshed daily; see EcsStack above).
- Datadog does **not** sign the webhook body in the generic integration,
  so HMAC isn't an option without a proxy. Header + IP allowlist is the
  practical baseline.

## Configuration: repo allowlist

`apps/agent/config/repos.yaml` (vendored, deploy-time):

```yaml
- service: api
  repo: org/api-server
  primary_branch: main
  hot_paths: ["src/handlers/**", "src/middleware/**"]
- service: workers
  repo: org/workers
  primary_branch: main
  hot_paths: ["src/jobs/**"]
```

Skills resolve `service:foo` from the alert tags → repo entry → ask the
sandbox to clone (shallow, depth=1, primary branch only).

## Local dev story

1. `pnpm install` at the root.
2. `pnpm --filter @opssage/agent dev` — runs the agent against a local
   sandbox process (no Docker needed for the skill loop).
3. Webhook testing: `pnpm dlx tunnelmole 8080` (or ngrok), point a
   throwaway Datadog webhook at the URL, set `X-OpsSage-Secret`.
4. Slack: a dev Slack workspace with the OpsSage app installed; bot
   token in `.env.local`. chat-sdk.dev's local mode renders to a small
   web preview as well.
5. Langfuse: free cloud project; keys in `.env.local`.

## CI/CD (GitHub Actions)

- `ci.yml` — on PR: install, typecheck, lint, unit tests, `cdk synth`.
- `deploy.yml` — on merge to `main`:
  1. Build + push `agent` and `sandbox` images to ECR (OIDC-assumed
     role, no long-lived AWS keys).
  2. `cdk deploy --all --require-approval never`.
  3. Smoke check: `curl https://<alb>/healthz` from the workflow.
- Skills are baked into the agent image — no separate publish step.

## Phasing

Ordered so we always have something working end-to-end:

1. **Skeleton (local).** pnpm workspace, agent package boots flue with
   the Cursor (or Anthropic-fallback) provider, loads one trivial skill
   that just summarizes a hard-coded Datadog payload from a fixture.
   Langfuse tracing on. Run via `pnpm dev`.
2. **Datadog tools + sandbox client.** Implement the Datadog API
   wrappers, gh CLI wrapper, sandbox RPC client. Skill is now real:
   `diagnose-5xx-spike` against a fixture alert + a real public
   GitHub repo for blame.
3. **Webhook receiver.** Hono server, header-secret verify, dedupe,
   `/healthz`. Fixture replays via `curl` locally.
4. **Slack delivery.** chat-sdk.dev wired to a dev Slack workspace.
   Bot replies in-thread on the existing Datadog→Slack alert message.
5. **Sandbox image.** Dockerfile + RPC server. Run locally via Compose
   alongside the agent.
6. **CDK infra.** Network + Secrets + ECS + Observability stacks.
   Manual `cdk deploy` from a laptop. Smoke a real Datadog webhook.
7. **CI/CD.** GitHub Actions for build+deploy. Daily DD-IP-range
   refresh.
8. **Hardening.** Constant-time secret compare, request size limits,
   timeouts on every external call, retries with jitter, structured
   logging.

Each phase ends with a runnable demo; nothing waits on the next.

## Out of scope (v1) / queued

- Daytona connector — revisit if ECS-native sandbox feels limiting.
- Skills registry — keep vendored until a second consumer exists.
- Other skills (`correlate-alert-with-deploys`,
  `explain-langfuse-regression`).
- Slack slash commands for manual invocation (architecture supports;
  ship in v1.1).
- Multi-platform chat (Teams, Discord) — chat-sdk.dev makes this a
  config change later.
- GitHub App migration from PAT — when org-wide use justifies it.
- Multi-tenant config (per-team repo allowlists, per-team Slack).

## Open questions still to resolve

- **Cursor provider in flue.** We have a Cursor key but haven't yet
  confirmed which flue provider module wires it up. Spike in phase 1.
- **Datadog webhook IP ranges.** Confirm the exact JSON path / category
  to filter (`webhooks` vs `agents` vs `all`). Done as part of the
  custom resource implementation.
- **chat-sdk.dev ↔ Datadog Slack message correlation.** Need to
  confirm we can locate the alert message reliably from the webhook
  payload (likely via `alert_url` in the Datadog message text).
- **Sandbox isolation level.** Pool-of-1 service is fine for one
  product surface; revisit if we need per-incident isolation.
- **Deploy account/region.** Which AWS account, which region, who owns
  the bootstrap (`cdk bootstrap`).
