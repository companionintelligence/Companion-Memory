#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Pull local-LLM credentials from the CI Hub, the same way CI-Hermes and
# CI-OpenClaw do. Writes an env file the entrypoint sources before launching.
#
# The Hub no longer proxies inference. Its /api/inference/apps/<slug>/credentials.env
# returns (for companion-memory):
#   LLM_API_BASE   — the DIRECT Ollama OpenAI-compatible /v1 (or a cloud provider URL)
#   LLM_API_KEY    — "ollama" for local, or the operator's cloud key
#   LLM_DEFAULT_CHAT_MODEL       — native Ollama model id (or cloud model)
#   LLM_DEFAULT_EMBEDDING_MODEL  — e.g. nomic-embed-text
#   OLLAMA_HOST    — the direct native Ollama URL
#
# The Hub still selects + pre-pulls the local model. LLM_API_BASE feeds the
# summary-service (OpenAI client); the NestJS API talks to OLLAMA_HOST natively.
#
# Idempotent and FAIL-OPEN: if the Hub is unreachable the container still starts
# and falls back to config/default.json. This never blocks boot.
# ──────────────────────────────────────────────────────────────────────────────
set -eu

CI_HUB_URL="${CI_HUB_URL:-http://ci-os-hub:3000}"
HUB_APP_SLUG="${HUB_APP_SLUG:-companion-memory}"
OUT_FILE="${HUB_BOOTSTRAP_FILE:-/tmp/ci-hub-bootstrap.env}"

log() { echo "[bootstrap-from-hub] $*" >&2; }

url="${CI_HUB_URL}/api/inference/apps/${HUB_APP_SLUG}/credentials.env"

if ! body="$(curl --silent --show-error --fail --max-time 5 --retry 1 --retry-delay 2 "${url}" 2>/dev/null)"; then
  log "Hub unreachable or returned an error at ${url}; using config defaults"
  exit 0
fi

if [ -z "${body}" ]; then
  log "Hub returned an empty bootstrap; using config defaults"
  exit 0
fi

tmp="$(mktemp)"
printf '%s\n' "${body}" > "${tmp}"
chmod 600 "${tmp}"
mv -f "${tmp}" "${OUT_FILE}"
log "wrote LLM config to ${OUT_FILE}"
