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

# ── Secrets: PowerSync (logical replication) ─────

: "${POWERSYNC_USERNAME:=$(get_secret POWERSYNC_DATABASE_USERNAME)}"
: "${POWERSYNC_USERNAME:=$DEFAULT_POWERSYNC_USERNAME}"
: "${POWERSYNC_PASSWORD:=$(get_secret POWERSYNC_DATABASE_PASSWORD)}"

# Tables the PowerSync replicator reads. Must stay in step with
# infrastructure/powersync/sync-rules.yaml: the role is granted SELECT on exactly
# these, and the `powersync` publication carries exactly these. A table added to
# the sync rules but not here fails at replication time with "permission denied".
: "${POWERSYNC_TABLES:=ci.notes ci.files ci_search.tags}"
: "${POWERSYNC_PUBLICATION:=powersync}"

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
  local role="$1" password="$2" attributes="${3:-}"
  echo "[ci/setup-database] Creating role '${role}' (if not exists)..."
  psql -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname = '${role}'" | grep -q 1 \
    || psql -d postgres -c "CREATE ROLE \"${role}\" WITH LOGIN ${attributes} PASSWORD '${password}';"
  # Always update the password and attributes to match current config — this is
  # what upgrades a role created by an earlier version of this script.
  psql -d postgres -c "ALTER ROLE \"${role}\" WITH ${attributes} PASSWORD '${password}';"
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

table_exists() {
  local dbname="$1" schema="${2%%.*}" table="${2#*.}"
  psql -d "$dbname" -tc \
    "SELECT 1 FROM pg_tables WHERE schemaname = '${schema}' AND tablename = '${table}'" \
    | grep -q 1
}

# Read-only access to a fixed list of tables, for the replication role. Tables
# that do not exist yet are skipped: on a fresh cluster this script runs before
# the migrations create them, and the next run (every `up` re-runs it) grants the
# rest. Re-granting an existing grant is a no-op, so this stays idempotent.
grant_table_reads() {
  local dbname="$1" role="$2"
  shift 2
  echo "[ci/setup-database] Granting read access on '${dbname}' to '${role}'..."
  psql -d "$dbname" -c "GRANT CONNECT ON DATABASE \"${dbname}\" TO \"${role}\";"
  for qualified in "$@"; do
    if table_exists "$dbname" "$qualified"; then
      psql -d "$dbname" -c "GRANT USAGE ON SCHEMA \"${qualified%%.*}\" TO \"${role}\";"
      psql -d "$dbname" -c "GRANT SELECT ON ${qualified} TO \"${role}\";"
    else
      echo "[ci/setup-database]   skipping ${qualified} — not created yet (run migrations, then re-run)."
    fi
  done
}

# The publication the PowerSync replicator subscribes to. Created empty so it
# exists from the first boot (the replicator errors out if it is missing), then
# converged to the table list — again skipping tables the migrations have not
# created yet. Deliberately not FOR ALL TABLES: that requires superuser to
# create, and would publish every table's WAL, including the TimescaleDB
# hypertables and pgvector embeddings that sync-rules.yaml keeps off-device.
create_publication() {
  local dbname="$1" publication="$2"
  shift 2
  echo "[ci/setup-database] Creating publication '${publication}' on '${dbname}' (if not exists)..."
  psql -d "$dbname" -tc "SELECT 1 FROM pg_publication WHERE pubname = '${publication}'" | grep -q 1 \
    || psql -d "$dbname" -c "CREATE PUBLICATION \"${publication}\";"
  for qualified in "$@"; do
    if ! table_exists "$dbname" "$qualified"; then
      echo "[ci/setup-database]   skipping ${qualified} — not created yet (run migrations, then re-run)."
      continue
    fi
    psql -d "$dbname" -tc \
      "SELECT 1 FROM pg_publication_tables
        WHERE pubname = '${publication}'
          AND schemaname = '${qualified%%.*}'
          AND tablename = '${qualified#*.}'" | grep -q 1 \
      || psql -d "$dbname" -c "ALTER PUBLICATION \"${publication}\" ADD TABLE ${qualified};"
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

# PowerSync (logical replication)
#
# A role of its own rather than REPLICATION on `companion`: `companion` owns every
# table and is what the API writes with, so widening it to WAL-sender rights would
# undo the least-privilege split above. This role can start a WAL sender and read
# the replicated tables — nothing else. Note the PowerSync service's *storage*
# connection is separate and still uses `companion`: it creates and migrates its
# own `powersync` schema, which needs write access this role must not have.
if [ -n "$POWERSYNC_PASSWORD" ]; then
  create_role "$POWERSYNC_USERNAME" "$POWERSYNC_PASSWORD" "REPLICATION"
  # shellcheck disable=SC2086 # deliberate word splitting: the table list
  grant_table_reads  "$COMPANION_DATABASE" "$POWERSYNC_USERNAME" $POWERSYNC_TABLES
  # shellcheck disable=SC2086
  create_publication "$COMPANION_DATABASE" "$POWERSYNC_PUBLICATION" $POWERSYNC_TABLES
else
  echo "[ci/setup-database] POWERSYNC_PASSWORD not set — skipping the replication role."
  echo "[ci/setup-database]   The powersync service will fail to authenticate until it is."
  echo "[ci/setup-database]   Set POWERSYNC_DATABASE_PASSWORD (see infrastructure/powersync/README.md)."
fi

echo "[ci/setup-database] Bootstrap complete."
