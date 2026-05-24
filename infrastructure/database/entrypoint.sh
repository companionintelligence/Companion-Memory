#!/bin/sh
set -e

# ──────────────────────────────────────────────────
# Secrets-aware entrypoint for PostgreSQL.
#
# Loads admin credentials from a shared secrets file
# when present, then falls back to environment variables
# or Dockerfile defaults (DEFAULT_USERNAME, DEFAULT_DATABASE).
#
# Maps canonical names to PostgreSQL-native env vars
# (POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB) before
# delegating to the upstream docker-entrypoint.sh.
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

: "${USERNAME:=$(get_secret DATABASE_ADMIN_USERNAME)}"
: "${USERNAME:=$DEFAULT_USERNAME}"
: "${PASSWORD:=$(get_secret DATABASE_ADMIN_PASSWORD)}"
: "${DATABASE:=$(get_secret DATABASE_ADMIN_NAME)}"
: "${DATABASE:=$DEFAULT_DATABASE}"

export POSTGRES_USER="$USERNAME"
export POSTGRES_PASSWORD="$PASSWORD"
export POSTGRES_DB="$DATABASE"

# ── Validation ───────────────────────────────────

fail=0

if [ -z "$POSTGRES_DB" ]; then
  echo "Warning: DATABASE is not set, defaulting to '$POSTGRES_USER'."
  echo ""
  echo "To set explicitly:"
  echo ""
  echo "  1. Add DATABASE_ADMIN_NAME to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the DATABASE environment variable directly"
fi

if [ -z "$POSTGRES_PASSWORD" ]; then
  echo "Error: PASSWORD is not set."
  echo ""
  echo "Please set the database admin password in one of the following ways:"
  echo ""
  echo "  1. Add DATABASE_ADMIN_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the PASSWORD environment variable directly"
  fail=1
fi

if [ -z "$POSTGRES_USER" ]; then
  echo "Error: USERNAME is not set."
  echo ""
  echo "Please set the database admin username in one of the following ways:"
  echo ""
  echo "  1. Add DATABASE_ADMIN_USERNAME to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the USERNAME environment variable directly"
  fail=1
fi

[ "$fail" -eq 1 ] && exit 1

# ── Launch ───────────────────────────────────────

exec docker-entrypoint.sh "$@"
