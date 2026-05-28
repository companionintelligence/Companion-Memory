#!/usr/bin/env bash
# Smoke-test the companion-memory backend surface.
#
# Hits the endpoints that currently exist on `main` (after the agent-memory
# merge):
#
#   GET  /api/graph/context        — user dossier
#   GET  /api/graph/search?query=  — graph search
#   POST /api/memory/recall        — Markdown recall block
#   POST /api/memory/turn          — conversation absorb (no-op stub)
#
# Usage:
#   COMPANION_MEMORY_API_KEY=ci_xxx ./scripts/companion-memory-smoke-test.sh

set -euo pipefail

URL="${COMPANION_MEMORY_URL:-http://localhost:3030}"
KEY="${COMPANION_MEMORY_API_KEY:-}"

if [[ -z "${KEY}" ]]; then
  echo "error: COMPANION_MEMORY_API_KEY must be set" >&2
  exit 1
fi

curl_json() {
  local method="$1"
  local path="$2"
  shift 2

  curl --silent --show-error --fail \
    --request "${method}" \
    --header "x-api-key: ${KEY}" \
    --header "content-type: application/json" \
    --header "accept: application/json" \
    "$@" \
    "${URL}${path}"
}

echo "→ /api/graph/context"
curl_json GET '/api/graph/context' >/dev/null
echo "  ok"

echo "→ /api/graph/search?query=smoke"
curl_json GET '/api/graph/search?query=smoke&limit=3' >/dev/null
echo "  ok"

echo "→ /api/memory/recall"
RECALL_RESPONSE="$(curl_json POST '/api/memory/recall' --data '{"query":"smoke","maxResults":3}')"
BLOCK_LEN="$(printf '%s' "${RECALL_RESPONSE}" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("block","")))')"
echo "  ok (block_chars=${BLOCK_LEN})"

echo "→ /api/memory/turn (no-op stub)"
SESSION_ID="smoke-$(date -u +%s)"
curl_json POST '/api/memory/turn' --data "$(cat <<JSON
{
  "sessionId": "${SESSION_ID}",
  "messages": [
    {"role": "user", "content": "smoke-test turn"},
    {"role": "assistant", "content": "ack"}
  ]
}
JSON
)" >/dev/null
echo "  ok"

echo
echo "companion-memory smoke test passed."
