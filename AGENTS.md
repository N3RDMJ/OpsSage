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
- **Tools via MCP.** Datadog, Langfuse, GitHub all plug in as MCP
  connectors or direct command definitions.

## What it does

- **Datadog** — reads metrics, logs, monitors, and APM traces. Triggered by
  Datadog webhooks (monitor alerts) as the primary entry point.
- **Langfuse** — pulls traces, sessions, and scores via the Langfuse API to
  reason about LLM-side failures (bad generations, regressions, cost spikes).
- **GitHub** — inspects the repository(ies) tied to the alert. Understands
  the codebase well enough to know *which* files to check. Two modes:
  - Lightweight: GitHub API + grep / code search.
  - Heavyweight: clone into a flue sandbox (Daytona or local mount) for
    deeper static analysis.

Each integration is exposed as a tool to the agent — most likely as MCP
servers — so skills can compose them freely.

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

Target is **Cursor via API key**, configured through flue's
provider-agnostic model layer. Swappable to Anthropic / OpenAI / etc.
without code changes.

## Open questions

- Which flue sandbox connector for the AWS path — Daytona vs. shipping
  our own ECS-native sandbox.
- How skills are distributed — vendored in-repo vs. pulled from a registry.
- Auth model for the Datadog webhook endpoint (signed payloads + allowlist).
- Whether Langfuse and Datadog get official MCP servers we can reuse, or
  we write thin ones.
