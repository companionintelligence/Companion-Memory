#!/usr/bin/env bash
# Companion Memory — one-shot installer.
#
# Installs the companion-memory MCP server, the Hermes plugin, and the
# OpenClaw skill in whichever surfaces are present on this machine.
#
# Usage:
#   COMPANION_MEMORY_API_KEY=ci_xxx ./scripts/install-companion-memory.sh [--mcp] [--hermes] [--openclaw] [--all]
#
# Default (no flags) is --all. Use --skip-build to skip the MCP TypeScript build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_MCP=0
INSTALL_HERMES=0
INSTALL_OPENCLAW=0
SKIP_BUILD=0

if [[ $# -eq 0 ]]; then
  INSTALL_MCP=1
  INSTALL_HERMES=1
  INSTALL_OPENCLAW=1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) INSTALL_MCP=1; INSTALL_HERMES=1; INSTALL_OPENCLAW=1 ;;
    --mcp) INSTALL_MCP=1 ;;
    --hermes) INSTALL_HERMES=1 ;;
    --openclaw) INSTALL_OPENCLAW=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "${COMPANION_MEMORY_API_KEY:-}" ]]; then
  echo "error: COMPANION_MEMORY_API_KEY must be set in the environment" >&2
  echo "       create one via: curl -X POST http://localhost:3030/api/keys ... " >&2
  exit 1
fi

export COMPANION_MEMORY_URL="${COMPANION_MEMORY_URL:-http://localhost:3030}"

step() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
note() { printf "    %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }

# ----------------------------------------------------------------------------
# MCP server
# ----------------------------------------------------------------------------

if [[ ${INSTALL_MCP} -eq 1 ]]; then
  step "Installing companion-memory MCP server"
  pushd "${REPO_ROOT}/mcp-servers/companion-memory" >/dev/null
  if [[ ${SKIP_BUILD} -eq 0 ]]; then
    if command -v yarn >/dev/null 2>&1; then
      note "Using yarn"
      yarn install --immutable --immutable-cache --check-cache 2>/dev/null || yarn install
      yarn build
    elif command -v npm >/dev/null 2>&1; then
      note "Using npm (no yarn detected)"
      npm install --no-fund --no-audit
      npm run build
    else
      warn "no yarn or npm found; skipping MCP build"
    fi
  else
    note "Skipping build (--skip-build)"
  fi
  popd >/dev/null
  note "Done. Built artefact: mcp-servers/companion-memory/dist/index.js"
fi

# ----------------------------------------------------------------------------
# Hermes plugin
# ----------------------------------------------------------------------------

if [[ ${INSTALL_HERMES} -eq 1 ]]; then
  step "Installing Hermes memory-provider plugin"
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found; skipping Hermes plugin install"
  else
    if ! command -v pip3 >/dev/null 2>&1; then
      warn "pip3 not found; skipping Hermes plugin install"
    else
      pip3 install --user -e "${REPO_ROOT}/plugins/hermes-companion-memory"
      HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
      mkdir -p "${HERMES_HOME}"
      python3 - "${HERMES_HOME}" "${COMPANION_MEMORY_URL}" "${COMPANION_MEMORY_NAMESPACE:-}" <<'PY'
import json, os, sys
hermes_home, base_url, namespace = sys.argv[1], sys.argv[2], sys.argv[3] or None
target = os.path.join(hermes_home, "companion_memory.json")
payload = {"base_url": base_url}
if namespace:
    payload["namespace"] = namespace
with open(target, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2, sort_keys=True)
print(f"wrote {target}")
PY
      note "Set COMPANION_MEMORY_API_KEY in your Hermes env (do not store the key on disk)."
      note "Then run: hermes memory setup → select 'companion-memory'."
    fi
  fi
fi

# ----------------------------------------------------------------------------
# OpenClaw skill
# ----------------------------------------------------------------------------

if [[ ${INSTALL_OPENCLAW} -eq 1 ]]; then
  step "Installing OpenClaw companion-memory skill"
  WORKSPACE="${OPENCLAW_WORKSPACE:-${HOME}/.openclaw/workspace}"
  if [[ ! -d "${WORKSPACE}" ]] && [[ ${INSTALL_OPENCLAW} -eq 1 ]] && [[ $# -eq 0 ]]; then
    warn "OpenClaw workspace ${WORKSPACE} does not exist; creating it"
    mkdir -p "${WORKSPACE}"
  fi
  "${REPO_ROOT}/plugins/openclaw-companion-memory/scripts/install.sh" "${WORKSPACE}"
fi

step "All requested surfaces installed."
note "Smoke-test the backend connection with: scripts/companion-memory-smoke-test.sh"
