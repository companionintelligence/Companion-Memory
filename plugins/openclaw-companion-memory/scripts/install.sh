#!/usr/bin/env bash
# Install the companion-memory skill into an OpenClaw workspace.
#
# Usage:
#   COMPANION_MEMORY_API_KEY=ci_xxx ./install.sh [workspace_path]
#
# If no workspace path is provided, OPENCLAW_WORKSPACE or ~/.openclaw/workspace
# is used.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SKILL_DIR}/../.." && pwd)"
MCP_DIST="${REPO_ROOT}/mcp-servers/companion-memory/dist/index.js"

WORKSPACE="${1:-${OPENCLAW_WORKSPACE:-${HOME}/.openclaw/workspace}}"
SKILL_TARGET="${WORKSPACE}/skills/companion-memory"
MCP_CONFIG="${WORKSPACE}/mcp_servers.json"

if [[ -z "${COMPANION_MEMORY_API_KEY:-}" ]]; then
  echo "error: COMPANION_MEMORY_API_KEY must be set" >&2
  exit 1
fi

if [[ ! -f "${MCP_DIST}" ]]; then
  echo "error: MCP server build not found at ${MCP_DIST}" >&2
  echo "       run \`yarn workspace @companionintelligence/companion-memory-mcp build\` first" >&2
  exit 1
fi

mkdir -p "${SKILL_TARGET}"
cp "${SKILL_DIR}/SKILL.md" "${SKILL_TARGET}/SKILL.md"
cp "${SKILL_DIR}/openclaw.skill.yaml" "${SKILL_TARGET}/openclaw.skill.yaml"

mkdir -p "$(dirname "${MCP_CONFIG}")"
TMP="$(mktemp)"
python3 - "$MCP_CONFIG" "$MCP_DIST" "${COMPANION_MEMORY_URL:-http://localhost:3030}" "${COMPANION_MEMORY_API_KEY}" > "$TMP" <<'PY'
import json, os, sys
config_path, mcp_dist, base_url, api_key = sys.argv[1:5]
config = {}
if os.path.exists(config_path):
    with open(config_path, "r", encoding="utf-8") as fh:
        try:
            config = json.load(fh) or {}
        except json.JSONDecodeError:
            config = {}
servers = config.get("mcpServers", {})
servers["companion-memory"] = {
    "command": "node",
    "args": [mcp_dist],
    "env": {
        "COMPANION_MEMORY_URL": base_url,
        "COMPANION_MEMORY_API_KEY": api_key,
    },
}
config["mcpServers"] = servers
print(json.dumps(config, indent=2, sort_keys=True))
PY
mv "${TMP}" "${MCP_CONFIG}"

cat <<EOF
✓ companion-memory skill installed at ${SKILL_TARGET}
✓ mcp_servers.json updated at ${MCP_CONFIG}

Restart OpenClaw to pick up the new skill, then ask it: "what's in my memory?".
EOF
