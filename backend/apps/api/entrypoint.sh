#!/bin/sh
set -e

# ──────────────────────────────────────────────────
# Secrets-aware entrypoint for the Companion API.
#
# Loads secrets from a shared secrets file when present,
# then falls back to environment variables already set
# by Docker Compose or the shell.
#
# Non-secret config defaults (hosts, ports, etc.) live
# in the application layer (config/default.json and
# config/production.json) — not here.
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

# ── Secrets ──────────────────────────────────────

: "${DATABASE_PASSWORD:=$(get_secret DATABASE_PASSWORD)}"
: "${OBJECT_STORE_USERNAME:=$(get_secret OBJECT_STORE_USERNAME)}"
: "${OBJECT_STORE_PASSWORD:=$(get_secret OBJECT_STORE_PASSWORD)}"
: "${AUTH_TOKEN_SECRET:=$(get_secret AUTH_TOKEN_SECRET)}"
: "${AUTH_REFRESH_TOKEN_SECRET:=$(get_secret AUTH_REFRESH_TOKEN_SECRET)}"
: "${AUTH_SESSION_PEPPER:=$(get_secret AUTH_SESSION_PEPPER)}"
: "${AUTH_FIELD_ENCRYPTION_KEY:=$(get_secret AUTH_FIELD_ENCRYPTION_KEY)}"
: "${AUTH_CSRF_TOKEN_SECRET:=$(get_secret AUTH_CSRF_TOKEN_SECRET)}"

export DATABASE_PASSWORD
export OBJECT_STORE_USERNAME OBJECT_STORE_PASSWORD
export AUTH_TOKEN_SECRET AUTH_REFRESH_TOKEN_SECRET
export AUTH_SESSION_PEPPER AUTH_FIELD_ENCRYPTION_KEY AUTH_CSRF_TOKEN_SECRET

# ── Validation ───────────────────────────────────

fail=0

if [ -z "$AUTH_CSRF_TOKEN_SECRET" ]; then
  echo "Error: AUTH_CSRF_TOKEN_SECRET is not set."
  echo ""
  echo "Please set the CSRF token secret in one of the following ways:"
  echo ""
  echo "  1. Add AUTH_CSRF_TOKEN_SECRET to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the AUTH_CSRF_TOKEN_SECRET environment variable directly"
  fail=1
fi

if [ -z "$AUTH_FIELD_ENCRYPTION_KEY" ]; then
  echo "Error: AUTH_FIELD_ENCRYPTION_KEY is not set."
  echo ""
  echo "Please set the field encryption key in one of the following ways:"
  echo ""
  echo "  1. Add AUTH_FIELD_ENCRYPTION_KEY to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the AUTH_FIELD_ENCRYPTION_KEY environment variable directly"
  fail=1
fi

if [ -z "$AUTH_REFRESH_TOKEN_SECRET" ]; then
  echo "Error: AUTH_REFRESH_TOKEN_SECRET is not set."
  echo ""
  echo "Please set the JWT refresh token secret in one of the following ways:"
  echo ""
  echo "  1. Add AUTH_REFRESH_TOKEN_SECRET to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the AUTH_REFRESH_TOKEN_SECRET environment variable directly"
  fail=1
fi

if [ -z "$AUTH_SESSION_PEPPER" ]; then
  echo "Error: AUTH_SESSION_PEPPER is not set."
  echo ""
  echo "Please set the session pepper in one of the following ways:"
  echo ""
  echo "  1. Add AUTH_SESSION_PEPPER to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the AUTH_SESSION_PEPPER environment variable directly"
  fail=1
fi

if [ -z "$AUTH_TOKEN_SECRET" ]; then
  echo "Error: AUTH_TOKEN_SECRET is not set."
  echo ""
  echo "Please set the JWT access token secret in one of the following ways:"
  echo ""
  echo "  1. Add AUTH_TOKEN_SECRET to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the AUTH_TOKEN_SECRET environment variable directly"
  fail=1
fi

if [ -z "$DATABASE_PASSWORD" ]; then
  echo "Error: DATABASE_PASSWORD is not set."
  echo ""
  echo "Please set the database password in one of the following ways:"
  echo ""
  echo "  1. Add DATABASE_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the DATABASE_PASSWORD environment variable directly"
  fail=1
fi

if [ -z "$OBJECT_STORE_PASSWORD" ]; then
  echo "Error: OBJECT_STORE_PASSWORD is not set."
  echo ""
  echo "Please set the object storage password in one of the following ways:"
  echo ""
  echo "  1. Add OBJECT_STORE_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the OBJECT_STORE_PASSWORD environment variable directly"
  fail=1
fi

if [ -z "$OBJECT_STORE_USERNAME" ]; then
  echo "Error: OBJECT_STORE_USERNAME is not set."
  echo ""
  echo "Please set the object storage username in one of the following ways:"
  echo ""
  echo "  1. Add OBJECT_STORE_USERNAME to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the OBJECT_STORE_USERNAME environment variable directly"
  fail=1
fi

[ "$fail" -eq 1 ] && exit 1

# ── Launch ───────────────────────────────────────

exec "$@"
