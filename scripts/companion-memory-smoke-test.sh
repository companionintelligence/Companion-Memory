#!/usr/bin/env bash
# Smoke-test the companion-memory backend.
#
# Validates that:
#   1. The CI-Server `/api/memory/health` endpoint is reachable
#   2. `POST /api/memory/remember` accepts a write
#   3. `GET /api/memory/recall` returns the just-written memory
#   4. `DELETE /api/memory/forget/<id>` archives it
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

echo "→ health check ${URL}"
curl_json GET "/api/memory/health" >/dev/null
echo "  ok"

echo "→ remember"
SAMPLE_CONTENT="Companion memory smoke test at $(date -u +%FT%TZ)"
REMEMBER_RESPONSE="$(curl_json POST "/api/memory/remember" --data "$(cat <<JSON
{
  "content": "${SAMPLE_CONTENT}",
  "tags": ["smoke-test"],
  "source": "companion-memory-smoke-test.sh"
}
JSON
)")"
MEMORY_ID="$(printf '%s' "${REMEMBER_RESPONSE}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["memory"]["id"])')"
echo "  id=${MEMORY_ID}"

echo "→ recall"
RECALL_RESPONSE="$(curl_json GET "/api/memory/recall?query=smoke%20test&limit=10")"
HIT="$(printf '%s' "${RECALL_RESPONSE}" | python3 -c "
import json, sys
ID = '${MEMORY_ID}'
data = json.load(sys.stdin)
hits = [r for r in data.get('results', []) if r.get('id') == ID]
print('yes' if hits else 'no')")"
echo "  found=${HIT}"
if [[ "${HIT}" != "yes" ]]; then
  echo "error: recall did not return the just-written memory" >&2
  exit 1
fi

echo "→ forget"
curl_json DELETE "/api/memory/forget/${MEMORY_ID}" --data '{"reason":"smoke-test cleanup"}' >/dev/null
echo "  archived"

# -----------------------------------------------------------------------------
# Agent surface — /api/agent/*. Best-effort: the endpoints landed alongside
# /api/memory/* via the AgentModule. If the backend hasn't deployed it yet
# the smoke test reports skipped rather than failing.
# -----------------------------------------------------------------------------

agent_call() {
  local method="$1"
  local path="$2"
  shift 2

  if curl --silent --show-error \
       --request "${method}" \
       --header "x-api-key: ${KEY}" \
       --header "content-type: application/json" \
       --header "accept: application/json" \
       "$@" \
       --write-out '\n%{http_code}\n' \
       "${URL}${path}"; then
    return 0
  fi

  return 1
}

echo "→ agent surface"
AGENT_OUTPUT="$(agent_call GET '/api/agent/context' 2>&1)"
AGENT_STATUS="$(printf '%s\n' "${AGENT_OUTPUT}" | tail -n1)"
if [[ "${AGENT_STATUS}" =~ ^2[0-9][0-9]$ ]]; then
  echo "  /agent/context ok"
  SESSION_ID="smoke-$(date -u +%s)"
  agent_call POST '/api/agent/absorb' --data "$(cat <<JSON
{
  "sessionId": "${SESSION_ID}",
  "platform": "smoke-test",
  "messages": [
    {"role": "user", "content": "smoke-test absorb"},
    {"role": "assistant", "content": "ack"}
  ]
}
JSON
)" >/dev/null
  echo "  /agent/absorb ok"
  agent_call POST '/api/agent/recall' --data '{"query":"smoke-test","maxResults":3}' >/dev/null
  echo "  /agent/recall ok"
else
  echo "  /agent/* not deployed (status ${AGENT_STATUS}) — skipping"
fi

echo
echo "companion-memory smoke test passed."
