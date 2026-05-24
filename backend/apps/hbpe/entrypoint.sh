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
: "${API_JWT_SECRET:=$(get_secret AUTH_TOKEN_SECRET)}"
export API_JWT_SECRET

if [ -z "$API_JWT_SECRET" ]; then
  echo "Error: API_JWT_SECRET is not set."
  echo ""
  echo "Please set the JWT secret in one of the following ways:"
  echo ""
  echo "  1. Add AUTH_TOKEN_SECRET to $SECRETS_FILE, or"
  echo "  2. Set the API_JWT_SECRET environment variable"
  exit 1
fi

echo "Starting CI-HBPE services..."

# Start the FastAPI histogram API in the background
echo "Starting HBPE API on port 8002..."
uvicorn ci.api:app --host 0.0.0.0 --port 8002 &
API_PID=$!

# Give the API a moment to start
sleep 2

# Start the Temporal worker in the background
echo "Starting HBPE Temporal worker..."
python -m ci.worker &
WORKER_PID=$!

shutdown() {
    echo "Shutting down HBPE services..."
    kill $API_PID $WORKER_PID 2>/dev/null || true
    wait $API_PID $WORKER_PID 2>/dev/null || true
    exit 0
}

trap shutdown SIGTERM SIGINT

wait $API_PID $WORKER_PID
