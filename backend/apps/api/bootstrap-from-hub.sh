#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Pull local-LLM config from the CI Hub, the same way CI-Hermes and CI-OpenClaw
# do. Writes an env file the entrypoint sources before launching the API.
#
# The Hub's /api/inference/apps/<slug>/bootstrap.env returns (for companion-memory):
#   LLM_API_BASE, LLM_API_KEY,
#   LLM_DEFAULT_CHAT_MODEL,      LLM_DEFAULT_CHAT_MODEL_BACKEND_ID,
#   LLM_DEFAULT_EMBEDDING_MODEL, LLM_DEFAULT_EMBEDDING_MODEL_BACKEND_ID
#
# The Hub selects the model for the detected hardware and pre-pulls it into its
# Ollama. LLM_API_BASE (OpenAI-compatible) is consumed by the summary-service;
# the *_BACKEND_ID values are the native-Ollama ids the NestJS API uses.
#
# Idempotent and FAIL-OPEN: if the Hub is unreachable the container still starts
# and falls back to config/default.json. This never blocks boot.
# ──────────────────────────────────────────────────────────────────────────────
set -eu

CI_HUB_URL="${CI_HUB_URL:-http://ci-os-hub:3000}"
HUB_APP_SLUG="${HUB_APP_SLUG:-companion-memory}"
OUT_FILE="${HUB_BOOTSTRAP_FILE:-/tmp/ci-hub-bootstrap.env}"

log() { echo "[bootstrap-from-hub] $*" >&2; }

url="${CI_HUB_URL}/api/inference/apps/${HUB_APP_SLUG}/bootstrap.env"

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
