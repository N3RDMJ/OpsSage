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

## Extensibility

OpsSage is meant to be expanded over time. Two extension models worth
borrowing from:

- **Extensions** — package-style modules built on
  [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Pi-mono already
  provides the building blocks we need: `@mariozechner/pi-ai` for a
  multi-provider LLM API (so swapping Cursor / Anthropic / OpenAI is one
  config change), `@mariozechner/pi-agent-core` for the agent runtime
  (tool-calling + state), plus terminal-UI and web-chat surfaces. Each
  OpsSage integration (Datadog, Langfuse, GitHub, PagerDuty, …) lives in
  its own package and registers tools through the pi-agent-core interface.
- **Skills** — instruction-shaped capabilities loaded on demand, modeled on
  [getsentry/warden](https://github.com/getsentry/warden). A skill bundles
  a prompt, the tools it needs, and any reference docs for one specific
  workflow (e.g. "diagnose a 5xx spike", "explain a Langfuse regression").

Both should be first-class: extensions add raw capability, skills compose
those capabilities into reusable playbooks.

## LLM

Target is **Cursor via API key** as the model provider. Routed through
`@mariozechner/pi-ai`, so the model is a swappable backend — anything
Cursor / Anthropic / OpenAI-compatible works behind the same interface.

## Open questions

- Sandbox strategy for cloning untrusted repos in the ECS path (Firecracker?
  per-task workspace volume?).
- How skills are distributed — vendored in-repo vs. pulled from a registry.
- Auth model for the Datadog webhook endpoint (signed payloads + allowlist).
