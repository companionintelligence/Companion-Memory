#!/bin/bash
set -e

# ──────────────────────────────────────────────────
# Secrets loading.
# Priority: Shell env (DATABASE_URL)  >  Shell env (DATABASE_PASSWORD)
#           >  Secrets file  >  fail
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
    echo "  1. Add DATABASE_PASSWORD to $SECRETS_FILE, or"
    echo "  2. Set the DATABASE_PASSWORD environment variable, or"
    echo "  3. Set DATABASE_URL to a full connection string"
    exit 1
  fi

  DATABASE_URL="postgresql://${DATABASE_USERNAME}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}"
fi

export DATABASE_URL

# ── API JWT Secret ────────────────────────────────
# Needed by graphql_client.py to self-sign service JWTs.
# The bearer the API presents on every request; this service refuses requests
# without it. It replaces API_JWT_SECRET (the API's own token-signing secret),
# which HBPE used to self-sign user tokens with — a secret that could act as
# any user. HBPE now only ever holds the per-run token the API hands it.
: "${SIDECAR_AUTH_SECRET:=$(get_secret SIDECAR_AUTH_SECRET)}"
export SIDECAR_AUTH_SECRET

if [ -z "$SIDECAR_AUTH_SECRET" ]; then
  echo "Error: SIDECAR_AUTH_SECRET is not set."
  echo ""
  echo "  1. Add SIDECAR_AUTH_SECRET to $SECRETS_FILE (setup-secrets does this), or"
  echo "  2. Set the SIDECAR_AUTH_SECRET environment variable"
  exit 1
fi

echo "Starting CI-HBPE services..."
# Scheduling is owned by the NestJS API (pg-boss crons); pipeline runs arrive
# through the API's /functions/run endpoint. There is no separate worker
# process anymore.

# Start the FastAPI histogram API (also hosts the function runner)
echo "Starting HBPE API on port 8002..."
uvicorn ci.hbpe.api:app --host 0.0.0.0 --port 8002 &
API_PID=$!

shutdown() {
    echo "Shutting down HBPE services..."
    kill $API_PID 2>/dev/null || true
    wait $API_PID 2>/dev/null || true
    exit 0
}

trap shutdown SIGTERM SIGINT

wait $API_PID
