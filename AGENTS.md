# OpsSage

A support / on-call agent built on
[withastro/flue](https://github.com/withastro/flue).

When something breaks, OpsSage is the first responder: it pulls signals from
the observability stack, reads the relevant code, and produces a triage
summary (root-cause hypothesis, affected surface area, suggested next step)
before a human gets paged.

## Why flue

Flue is "the agent harness framework" — runtime-agnostic, headless,
programmable. It already gives us almost everything OpsSage needs as
infrastructure, so we build *on* it rather than reinvent any of it:

- **Skills system, native.** Markdown skills + `AGENTS.md` (this file) is
  flue's default config. Our extension model is just flue's extension model.
- **Sandboxes, solved.** Local filesystem mount, Cloudflare Workers, and
  Daytona for remote containers. That's our answer for cloning repos for
  deeper inspection — pick a connector, don't design one.
- **Provider-agnostic.** Flue works with any agent / model, so Cursor via
  API key is a config switch, not an architectural concern.
- **Session persistence + roles** come for free (Durable Objects on the
  CF runtime, in-process otherwise).
- **Shell-first tools.** Flue gives the agent a sandbox with shell
  access, so integrations are CLIs and HTTP APIs the agent invokes
  directly — same way a human operator would.

## What it does

All integrations go through CLIs and HTTP APIs — no MCP servers in the
middle. The flue sandbox already gives the agent shell access, so the
fewer layers between the agent and the source of truth, the better.

- **Datadog** — `datadog-ci` for the operations it covers (CI visibility,
  synthetics, deployments) plus `curl` against the Datadog API for
  metrics, logs, monitors, and APM traces. Triggered by Datadog webhooks
  (monitor alerts) as the primary entry point.
- **Langfuse** — direct calls to the Langfuse API for traces, sessions,
  scores, and generations. The official Langfuse MCP doesn't cover
  observability primitives, which is the other reason CLI/API beats MCP
  here.
- **GitHub** — `gh` CLI for everyday operations (repo / PR / issue /
  search), GitHub API for anything `gh` doesn't expose cleanly. Two
  modes:
  - Lightweight: `gh search code` + grep against shallow clones.
  - Heavyweight: full clone into a flue sandbox (Daytona or local mount)
    for deeper static analysis.

Skills compose these by shelling out — no plugin layer.

## Where it runs

Same flue agent, three deployment shapes:

- **Locally** — flue with the local-filesystem-mount sandbox; for
  development and the "single operator" use case.
- **AWS** — flue process on ECS (Fargate) behind API Gateway / ALB that
  receives Datadog webhooks. Daytona handles repo cloning when a skill
  needs a sandbox.
- **Windows VM** — flue with local filesystem mount, using the VM itself
  as the workspace. Useful when an org already provisions a jumpbox per
  engineer.

The runtime is a thin wrapper; the agent core is identical across all
three.

## Skills

Capabilities are added as flue skills — Markdown files describing one
specific workflow (a prompt + the tools it needs + any reference docs).
Examples:

- `diagnose-5xx-spike` — Datadog metrics + APM traces + recent deploys +
  GitHub blame on the hot path.
- `explain-langfuse-regression` — Langfuse traces + scores diff vs.
  baseline + recent prompt/code changes.
- `correlate-alert-with-deploys` — alert window ↔ deploy history ↔ PRs
  merged in that window.

Skills are the single extension surface. Integrations stay as tools, not
plugins, so a skill can pull in whichever ones the workflow needs without
crossing a plugin boundary. This matches how a human runbook is written,
which is the right shape for an on-call tool.

## LLM

**Anthropic** via flue's provider-agnostic model layer (pi-ai), reading
`ANTHROPIC_API_KEY` from env. Model namespace is `anthropic/<model-id>`,
swappable to OpenAI, Google, Bedrock, etc. without code changes — every
pi-ai built-in provider is a one-line config swap.

Cursor was the original target, but Cursor's public API is the [Cloud
Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) and
the `@cursor/sdk` coding-agent runtime — both are agent-orchestration
products, not raw inference. There's no `/v1/messages` to point flue's
model layer at. If Cursor's models become useful for deep code
investigation, the right shape is "Cursor SDK as a tool the skill
invokes" (alongside `gh`, `datadog-ci`, etc.) — not "Cursor as the
LLM provider".

## Open questions

- Which flue sandbox connector for the AWS path — Daytona vs. shipping
  our own ECS-native sandbox.
- How skills are distributed — vendored in-repo vs. pulled from a registry.
- Auth model for the Datadog webhook endpoint (signed payloads + allowlist).
- Credential delivery to the sandbox — env vars vs. mounted secrets vs.
  a small auth proxy in front of the upstream APIs.
- Rate limits / quota handling for Datadog and GitHub when a skill fans
  out across many calls.
