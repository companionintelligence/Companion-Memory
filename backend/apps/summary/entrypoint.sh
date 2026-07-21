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

# ── LLM ──────────────────────────────────────────
# Only export when a key is actually configured. Exporting an empty string
# would clobber the application-layer default ("ollama"), which Ollama ignores
# but the OpenAI client requires to be non-empty.

: "${LLM_API_KEY:=$(get_secret LLM_API_KEY)}"
[ -n "$LLM_API_KEY" ] && export LLM_API_KEY

# ── Start services ───────────────────────────────

echo "Starting CI-Summary services..."

# Start the FastAPI summary API in the background
echo "Starting FastAPI summary API server on port 8001..."
uvicorn src.api:app --host 0.0.0.0 --port 8001 &
API_PID=$!

# Start the FastAPI parser API in the background
echo "Starting FastAPI parser API server on port 8002..."
uvicorn src.parser:app --host 0.0.0.0 --port 8002 &
PARSER_PID=$!

# Give the APIs a moment to start
sleep 2

# Start the Temporal worker
echo "Starting Temporal worker..."
python -m src.worker &
WORKER_PID=$!

# Run unified startup checks and setup
# This waits for Temporal and then configures system schedules
python -m src.startup &


# Function to handle shutdown gracefully
shutdown() {
    echo "Shutting down services..."
    kill $API_PID $PARSER_PID $WORKER_PID 2>/dev/null || true
    wait $API_PID $PARSER_PID $WORKER_PID 2>/dev/null || true
    exit 0
}

# Trap SIGTERM and SIGINT
trap shutdown SIGTERM SIGINT

# Wait for all processes
wait $API_PID $PARSER_PID $WORKER_PID
