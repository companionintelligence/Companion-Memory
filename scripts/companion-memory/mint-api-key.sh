#!/usr/bin/env bash
# Convenience: mint a new API key against a running CI-Server using a JWT
# session token (e.g. from `make gentoken`).
#
# Usage:
#   CI_SERVER_URL=http://localhost:3030 CI_SERVER_JWT=eyJ... \
#     ./scripts/companion-memory/mint-api-key.sh "companion-memory"

set -euo pipefail

URL="${CI_SERVER_URL:-http://localhost:3030}"
JWT="${CI_SERVER_JWT:-}"
NAME="${1:-companion-memory}"

if [[ -z "${JWT}" ]]; then
  echo "error: CI_SERVER_JWT must be set (use \`make gentoken\` to obtain one)" >&2
  exit 1
fi

curl --silent --show-error --fail \
  --request POST \
  --header "authorization: Bearer ${JWT}" \
  --header "content-type: application/json" \
  --data "$(cat <<JSON
{
  "name": "${NAME}",
  "scopes": ["memory:read", "memory:write"]
}
JSON
)" \
  "${URL}/api/keys" \
  | python3 -m json.tool
