#!/bin/sh
set -e

# ──────────────────────────────────────────────────
# Database bootstrapping: creates application-specific
# roles and databases so each service connects with
# least-privilege credentials instead of the superuser.
#
# Runs once as an init container after PostgreSQL is healthy.
# Idempotent — safe to re-run on an existing cluster.
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

# ── Secrets: Admin (superuser) ───────────────────

: "${ADMIN_USERNAME:=$(get_secret DATABASE_ADMIN_USERNAME)}"
: "${ADMIN_USERNAME:=$DEFAULT_ADMIN_USERNAME}"
: "${ADMIN_PASSWORD:=$(get_secret DATABASE_ADMIN_PASSWORD)}"
: "${ADMIN_HOST:=$(get_secret DATABASE_HOST)}"
: "${ADMIN_HOST:=$DEFAULT_HOST}"
: "${ADMIN_PORT:=5432}"

export PGHOST="$ADMIN_HOST"
export PGPORT="$ADMIN_PORT"
export PGUSER="$ADMIN_USERNAME"
export PGPASSWORD="$ADMIN_PASSWORD"

# ── Secrets: Application (Companion API) ─────────

: "${COMPANION_USERNAME:=$(get_secret DATABASE_USERNAME)}"
: "${COMPANION_USERNAME:=$DEFAULT_COMPANION_USERNAME}"
: "${COMPANION_PASSWORD:=$(get_secret DATABASE_PASSWORD)}"
: "${COMPANION_DATABASE:=$DEFAULT_COMPANION_DATABASE}"

# ── Secrets: Orchestrator (Temporal) ─────────────

: "${ORCHESTRATOR_USERNAME:=$(get_secret ORCHESTRATOR_DATABASE_USERNAME)}"
: "${ORCHESTRATOR_USERNAME:=$DEFAULT_ORCHESTRATOR_USERNAME}"
: "${ORCHESTRATOR_PASSWORD:=$(get_secret ORCHESTRATOR_DATABASE_PASSWORD)}"
: "${ORCHESTRATOR_DATABASE:=$DEFAULT_ORCHESTRATOR_DATABASE}"
: "${ORCHESTRATOR_VISIBILITY_DATABASE:=${ORCHESTRATOR_DATABASE}_visibility}"

# ── Validation ───────────────────────────────────

fail=0

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "Error: ADMIN_PASSWORD is not set."
  echo ""
  echo "Please set the superuser password in one of the following ways:"
  echo ""
  echo "  1. Add DATABASE_ADMIN_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the ADMIN_PASSWORD environment variable directly"
  fail=1
fi

if [ -z "$ADMIN_USERNAME" ]; then
  echo "Error: ADMIN_USERNAME is not set."
  echo ""
  echo "Please set the superuser username in one of the following ways:"
  echo ""
  echo "  1. Add DATABASE_ADMIN_USERNAME to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the ADMIN_USERNAME environment variable directly"
  fail=1
fi

if [ -z "$COMPANION_PASSWORD" ]; then
  echo "Error: COMPANION_PASSWORD is not set."
  echo ""
  echo "Please set the application database password in one of the following ways:"
  echo ""
  echo "  1. Add DATABASE_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the COMPANION_PASSWORD environment variable directly"
  fail=1
fi

if [ -z "$ORCHESTRATOR_PASSWORD" ]; then
  echo "Error: ORCHESTRATOR_PASSWORD is not set."
  echo ""
  echo "Please set the orchestrator database password in one of the following ways:"
  echo ""
  echo "  1. Add ORCHESTRATOR_DATABASE_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the ORCHESTRATOR_PASSWORD environment variable directly"
  fail=1
fi

[ "$fail" -eq 1 ] && exit 1

# ── Helpers ──────────────────────────────────────

create_role() {
  local role="$1" password="$2"
  echo "[ci/setup-database] Creating role '${role}' (if not exists)..."
  psql -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname = '${role}'" | grep -q 1 \
    || psql -d postgres -c "CREATE ROLE \"${role}\" WITH LOGIN PASSWORD '${password}';"
  # Always update the password to match current config
  psql -d postgres -c "ALTER ROLE \"${role}\" WITH PASSWORD '${password}';"
}

create_database() {
  local dbname="$1" owner="$2"
  echo "[ci/setup-database] Creating database '${dbname}' owned by '${owner}' (if not exists)..."
  psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '${dbname}'" | grep -q 1 \
    || psql -d postgres -c "CREATE DATABASE \"${dbname}\" OWNER \"${owner}\";"
  psql -d postgres -c "ALTER DATABASE \"${dbname}\" OWNER TO \"${owner}\";"
}

enable_extensions() {
  local dbname="$1"
  shift
  echo "[ci/setup-database] Enabling extensions on '${dbname}'..."
  for ext in "$@"; do
    psql -d "$dbname" -c "CREATE EXTENSION IF NOT EXISTS \"${ext}\";"
  done
}

# ── Main ─────────────────────────────────────────

echo "[ci/setup-database] Bootstrapping database roles and databases..."

# Application (Companion API)
create_role     "$COMPANION_USERNAME"  "$COMPANION_PASSWORD"
create_database "$COMPANION_DATABASE"  "$COMPANION_USERNAME"
enable_extensions "$COMPANION_DATABASE" \
  timescaledb postgis vector pg_stat_statements btree_gist

# Orchestrator (Temporal)
create_role     "$ORCHESTRATOR_USERNAME"             "$ORCHESTRATOR_PASSWORD"
create_database "$ORCHESTRATOR_DATABASE"             "$ORCHESTRATOR_USERNAME"
create_database "$ORCHESTRATOR_VISIBILITY_DATABASE"  "$ORCHESTRATOR_USERNAME"

echo "[ci/setup-database] Bootstrap complete."
