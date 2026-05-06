#!/usr/bin/env bash
# Replay the bundled fixture against a locally-running agent.
#
# Datadog webhooks are configured to POST to:
#   https://<alb>/agents/diagnose-5xx-spike/<run-id>
# with the X-OpsSage-Secret header set to the shared secret. The <run-id>
# segment is opaque to the agent — we use the Datadog aggregation_key.
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
RUN_ID="${RUN_ID:-fixture-$(date +%s)}"
URL="${URL:-${BASE}/agents/diagnose-5xx-spike/${RUN_ID}}"
SECRET="${OPSSAGE_WEBHOOK_SECRET:-replace-with-32-byte-random}"
FIXTURE="${1:-apps/agent/fixtures/datadog-5xx-spike.json}"

curl --fail --silent --show-error \
  -H "Content-Type: application/json" \
  -H "X-OpsSage-Secret: ${SECRET}" \
  --data @"${FIXTURE}" \
  "${URL}" | jq .
