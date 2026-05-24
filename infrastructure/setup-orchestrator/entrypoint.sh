#!/bin/sh
set -e

# ──────────────────────────────────────────────────
# Temporal schema setup (DB creation + schema migration).
#
# Runs once as an init container before the server.
# Namespace registration is handled by the server
# entrypoint (infrastructure/orchestrator/entrypoint.sh).
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

# ── Defaults ─────────────────────────────────────

: "${DB:=postgres12_pgx}"
: "${DB_PORT:=5432}"
: "${DBNAME:=$DATABASE_NAME}"
: "${VISIBILITY_DBNAME:=${DATABASE_NAME}_visibility}"
: "${POSTGRES_SEEDS:=$DATABASE_HOST}"
: "${SKIP_SCHEMA_SETUP:=false}"

SCHEMA_DIR="/etc/temporal/schema/postgresql/v12"
export SQL_PASSWORD="${POSTGRES_PWD}"

# ── Helpers ──────────────────────────────────────

run_sql_tool() {
  temporal-sql-tool \
    --plugin "${DB}" \
    --ep "${POSTGRES_SEEDS}" \
    -u "${POSTGRES_USER}" \
    -p "${DB_PORT}" \
    "$@"
}

# ── Schema setup ─────────────────────────────────
# Database creation is handled by setup-database.
# This container only runs schema migrations.

if [ "${SKIP_SCHEMA_SETUP}" = "true" ]; then
  echo "[ci/setup-orchestrator] SKIP_SCHEMA_SETUP=true, skipping."
  exit 0
fi

# Main database
echo "[ci/setup-orchestrator] Setting up schema for '${DBNAME}'..."
run_sql_tool --db "${DBNAME}" setup-schema -v 0.0 || true

echo "[ci/setup-orchestrator] Updating schema for '${DBNAME}'..."
run_sql_tool --db "${DBNAME}" update-schema -d "${SCHEMA_DIR}/temporal/versioned"

# Visibility database
echo "[ci/setup-orchestrator] Setting up schema for '${VISIBILITY_DBNAME}'..."
run_sql_tool --db "${VISIBILITY_DBNAME}" setup-schema -v 0.0 || true

echo "[ci/setup-orchestrator] Updating schema for '${VISIBILITY_DBNAME}'..."
run_sql_tool --db "${VISIBILITY_DBNAME}" update-schema -d "${SCHEMA_DIR}/visibility/versioned"

echo "[ci/setup-orchestrator] Schema setup complete."
