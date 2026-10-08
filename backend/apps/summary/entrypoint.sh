#!/bin/bash
# Entrypoint for the CI-Summary service.
# Loads secrets, assembles DATABASE_URL, then starts services.

set -e

# ──────────────────────────────────────────────────
# Secrets loading. Non-secret config defaults (hosts,
# ports, models, etc.) live in the application layer
# (src/config.py) — not here.
#
# Priority: Shell env  >  Secrets file  >  (fail)
# ──────────────────────────────────────────────────

SECRETS_FILE="${SECRETS_FILE:-/run/secrets/.env.secrets}"

get_secret() {
  [ -f "$SECRETS_FILE" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in \#*|"") continue ;; esac
    if [ "$key" = "$1" ]; then
      printf '%s' "$value" | tr -d '\r'
      return
    fi
  done < "$SECRETS_FILE"
}

# ── Database ─────────────────────────────────────

if [ -z "$DATABASE_URL" ]; then
  : "${DATABASE_HOST:=$(get_secret DATABASE_HOST)}"
  : "${DATABASE_HOST:=database}"
  : "${DATABASE_PORT:=$(get_secret DATABASE_PORT)}"
  : "${DATABASE_PORT:=5432}"
  : "${DATABASE_USERNAME:=$(get_secret DATABASE_USERNAME)}"
  : "${DATABASE_USERNAME:=companion}"
  : "${DATABASE_PASSWORD:=$(get_secret DATABASE_PASSWORD)}"
  : "${DATABASE_NAME:=$(get_secret DATABASE_NAME)}"
  : "${DATABASE_NAME:=companion}"

  if [ -z "$DATABASE_PASSWORD" ]; then
    echo "Error: DATABASE_PASSWORD is not set and DATABASE_URL was not provided."
    echo ""
    echo "Please set the database password in one of the following ways:"
    echo ""
    echo "  1. Add DATABASE_PASSWORD to the secrets file at $SECRETS_FILE, or"
    echo "  2. Set the DATABASE_PASSWORD environment variable directly, or"
    echo "  3. Set DATABASE_URL to a full connection string"
    exit 1
  fi

  DATABASE_URL="postgresql://${DATABASE_USERNAME}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}"
fi

export DATABASE_URL

# ── API JWT Secret ────────────────────────────────
# Needed by the function runner to self-sign the JWT on run-completion
# callbacks to the NestJS API. Same pattern as the HBPE entrypoint.
# The bearer the API presents on every request; this service refuses requests
# without it. Replaces API_JWT_SECRET (the API's token-signing secret, which the
# runner used to self-sign callback tokens with); the runner now echoes the
# per-run token the API hands it instead.
: "${SIDECAR_AUTH_SECRET:=$(get_secret SIDECAR_AUTH_SECRET)}"
export SIDECAR_AUTH_SECRET
if [ -z "$SIDECAR_AUTH_SECRET" ]; then
  echo "Error: SIDECAR_AUTH_SECRET is not set."
  echo ""
  echo "  1. Add SIDECAR_AUTH_SECRET to $SECRETS_FILE (setup-secrets does this), or"
  echo "  2. Set the SIDECAR_AUTH_SECRET environment variable"
  exit 1
fi

# ── LLM ──────────────────────────────────────────
# Only export when a key is actually configured. Exporting an empty string
# would clobber the application-layer default ("ollama"), which Ollama ignores
# but the OpenAI client requires to be non-empty.

: "${LLM_API_KEY:=$(get_secret LLM_API_KEY)}"
[ -n "$LLM_API_KEY" ] && export LLM_API_KEY

# ── Start services ───────────────────────────────
# Scheduling is owned by the NestJS API (pg-boss crons); background work
# arrives through the summary API's /functions/run endpoint. There is no
# separate worker process anymore.

echo "Starting CI-Summary services..."

# Start the FastAPI summary API (manual triggers + function runner)
echo "Starting FastAPI summary API server on port 8001..."
uvicorn ci.summary.api:app --host 0.0.0.0 --port 8001 &
API_PID=$!

# Start the FastAPI parser API in the background
echo "Starting FastAPI parser API server on port 8002..."
uvicorn ci.summary.parser:app --host 0.0.0.0 --port 8002 &
PARSER_PID=$!

# Function to handle shutdown gracefully
shutdown() {
    echo "Shutting down services..."
    kill $API_PID $PARSER_PID 2>/dev/null || true
    wait $API_PID $PARSER_PID 2>/dev/null || true
    exit 0
}

# Trap SIGTERM and SIGINT
trap shutdown SIGTERM SIGINT

# Wait for EITHER service to exit, then take the container down with it.
#
# `wait $API_PID $PARSER_PID` waited for both, so when one died (the parser
# OOM-killed by a document, say) the container stayed up with half its
# services, and its healthcheck could still pass. Every later parse then failed
# until someone restarted summary-service by hand. Exiting non-zero here hands
# the restart to Docker's restart policy.
status=0
wait -n "$API_PID" "$PARSER_PID" || status=$?
echo "A CI-Summary service exited (status $status); stopping the container so it restarts" >&2
kill "$API_PID" "$PARSER_PID" 2>/dev/null || true
wait "$API_PID" "$PARSER_PID" 2>/dev/null || true
if [ "$status" -eq 0 ]; then
  status=1
fi
exit "$status"
