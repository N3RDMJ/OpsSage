# OpsSage

A support / on-call agent inspired by [withastro/flue](https://github.com/withastro/flue).

When something breaks, OpsSage is the first responder: it pulls signals from
the observability stack, reads the relevant code, and produces a triage
summary (root-cause hypothesis, affected surface area, suggested next step)
before a human gets paged.

## What it does

- **Datadog** — reads metrics, logs, monitors, and APM traces. Triggered by
  Datadog webhooks (monitor alerts) as the primary entry point.
- **Langfuse** — pulls traces, sessions, and scores via the Langfuse API to
  reason about LLM-side failures (bad generations, regressions, cost spikes).
- **GitHub** — inspects the repository(ies) tied to the alert. Understands the
  codebase well enough to know *which* files to check. Two modes:
  - Lightweight: GitHub API + grep / code search.
  - Heavyweight: clone into a sandbox for deeper static analysis.

## Where it runs

- **Locally** — for development and the "single operator" use case.
- **AWS** — ECS task (Fargate) fronted by an API Gateway / ALB that receives
  Datadog webhooks.
- **Windows VM** — alternative deployment that uses the VM itself as the
  filesystem / sandbox (useful for environments that already provision a
  jumpbox per engineer).

The runtime should be a thin wrapper; the same agent core runs in all three.

## Extensibility — skills

OpsSage extends through **skills**, modeled on
[getsentry/warden](https://github.com/getsentry/warden). A skill is an
instruction-shaped capability loaded on demand: a prompt + the tools it
needs + any reference docs, all bundled for one specific workflow
(e.g. "diagnose a 5xx spike", "explain a Langfuse regression",
"correlate an alert with recent deploys").

Skills are the single extension surface. We deliberately *don't* add a
second plugin tier on top:

- **Integrations are tools, not extensions.** Datadog, Langfuse, GitHub,
  PagerDuty, etc. are implemented as tools registered against
  `@mariozechner/pi-agent-core` from
  [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Skills pull
  in whichever tools they need.
- **Why skills over package-style extensions.** The unit of value for an
  on-call agent is the *workflow*, not the integration. A "5xx spike"
  skill needs Datadog + GitHub + deploy history together; splitting that
  across plugins fragments the prompt and the reference docs that make
  the workflow good. Skills also stay close to how a human runbook is
  written, which is the right shape for this tool.

## LLM

Target is **Cursor via API key** as the model provider. Routed through
`@mariozechner/pi-ai`, so the model is a swappable backend — anything
Cursor / Anthropic / OpenAI-compatible works behind the same interface.

## Open questions

- Sandbox strategy for cloning untrusted repos in the ECS path (Firecracker?
  per-task workspace volume?).
- How skills are distributed — vendored in-repo vs. pulled from a registry.
- Auth model for the Datadog webhook endpoint (signed payloads + allowlist).
