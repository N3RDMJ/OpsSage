#!/usr/bin/env bash
# Replay the bundled fixture against a locally-running agent.
set -euo pipefail

URL="${URL:-http://localhost:8080/v1/events/datadog}"
SECRET="${OPSSAGE_WEBHOOK_SECRET:-replace-with-32-byte-random}"
FIXTURE="${1:-apps/agent/fixtures/datadog-5xx-spike.json}"

curl --fail --silent --show-error \
  -H "Content-Type: application/json" \
  -H "X-OpsSage-Secret: ${SECRET}" \
  --data @"${FIXTURE}" \
  "${URL}" | jq .
