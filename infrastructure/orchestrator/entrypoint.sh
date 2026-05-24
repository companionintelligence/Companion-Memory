#!/bin/sh
set -e

# ──────────────────────────────────────────────────
# Secrets-aware entrypoint for Temporal (orchestrator).
#
# Loads database credentials from a shared secrets file
# when present, then falls back to environment variables
# or Dockerfile defaults.
#
# Maps canonical names to Temporal-native env vars
# (POSTGRES_USER, POSTGRES_PWD, POSTGRES_SEEDS, etc.)
# before delegating to the upstream Temporal entrypoint.
#
# Also registers the default namespace in the background
# once the server is up.
#
# Priority: Shell env  >  Secrets file  >  Dockerfile default
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

# ── Secrets ──────────────────────────────────────

: "${DATABASE_USERNAME:=$(get_secret ORCHESTRATOR_DATABASE_USERNAME)}"
: "${DATABASE_USERNAME:=$DEFAULT_DATABASE_USERNAME}"
: "${DATABASE_PASSWORD:=$(get_secret ORCHESTRATOR_DATABASE_PASSWORD)}"
: "${DATABASE_HOST:=$(get_secret ORCHESTRATOR_DATABASE_HOST)}"
: "${DATABASE_HOST:=$DEFAULT_DATABASE_HOST}"
: "${DATABASE_NAME:=$(get_secret ORCHESTRATOR_DATABASE_NAME)}"
: "${DATABASE_NAME:=$DEFAULT_DATABASE_NAME}"

export POSTGRES_USER="$DATABASE_USERNAME"
export POSTGRES_PWD="$DATABASE_PASSWORD"
export POSTGRES_SEEDS="$DATABASE_HOST"
export DBNAME="$DATABASE_NAME"

: "${VISIBILITY_DATABASE_NAME:=$(get_secret ORCHESTRATOR_VISIBILITY_DATABASE_NAME)}"
: "${VISIBILITY_DATABASE_NAME:=$DEFAULT_VISIBILITY_DATABASE_NAME}"
: "${VISIBILITY_DATABASE_NAME:=${DATABASE_NAME}_visibility}"
export VISIBILITY_DBNAME="$VISIBILITY_DATABASE_NAME"

# ── Validation ───────────────────────────────────

fail=0

if [ -z "$POSTGRES_PWD" ]; then
  echo "Error: DATABASE_PASSWORD is not set."
  echo ""
  echo "Please set the database password in one of the following ways:"
  echo ""
  echo "  1. Add ORCHESTRATOR_DATABASE_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the DATABASE_PASSWORD environment variable directly"
  fail=1
fi

if [ -z "$POSTGRES_USER" ]; then
  echo "Error: DATABASE_USERNAME is not set."
  echo ""
  echo "Please set the database username in one of the following ways:"
  echo ""
  echo "  1. Add ORCHESTRATOR_DATABASE_USERNAME to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the DATABASE_USERNAME environment variable directly"
  fail=1
fi

[ "$fail" -eq 1 ] && exit 1

# ── Namespace Registration ───────────────────────

: "${SKIP_DEFAULT_NAMESPACE_CREATION:=false}"
: "${DEFAULT_NAMESPACE:=default}"
: "${DEFAULT_NAMESPACE_RETENTION:=24h}"

if [ "${SKIP_DEFAULT_NAMESPACE_CREATION}" != "true" ]; then
  (
    export TEMPORAL_ADDRESS="localhost:7233"
    echo "[ci/orchestrator] Will register namespace '${DEFAULT_NAMESPACE}' once server is ready..."
    sleep 5
    until temporal operator namespace describe "${DEFAULT_NAMESPACE}" > /dev/null 2>&1; do
      temporal operator namespace create \
        --retention "${DEFAULT_NAMESPACE_RETENTION}" \
        --description "Default workflow namespace." \
        "${DEFAULT_NAMESPACE}" 2>/dev/null && break
      sleep 3
    done
    echo "[ci/orchestrator] Namespace '${DEFAULT_NAMESPACE}' is ready."
  ) &
fi

# ── Launch ───────────────────────────────────────

exec /etc/temporal/entrypoint.sh "$@"
