#!/bin/sh
set -e

# ──────────────────────────────────────────────────
# Secrets-aware entrypoint for MinIO (object storage).
#
# Loads credentials from a shared secrets file when
# present, then falls back to environment variables
# already set by Docker Compose or the shell.
#
# Maps canonical names to MinIO-native env vars
# (MINIO_ROOT_USER, MINIO_ROOT_PASSWORD) before
# delegating to the minio binary.
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

: "${USERNAME:=$(get_secret OBJECT_STORE_USERNAME)}"
: "${PASSWORD:=$(get_secret OBJECT_STORE_PASSWORD)}"

export MINIO_ROOT_USER="$USERNAME"
export MINIO_ROOT_PASSWORD="$PASSWORD"

# ── Validation ───────────────────────────────────

fail=0

if [ -z "$MINIO_ROOT_PASSWORD" ]; then
  echo "Error: PASSWORD is not set."
  echo ""
  echo "Please set the object storage password in one of the following ways:"
  echo ""
  echo "  1. Add OBJECT_STORE_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the PASSWORD environment variable directly"
  fail=1
fi

if [ -z "$MINIO_ROOT_USER" ]; then
  echo "Error: USERNAME is not set."
  echo ""
  echo "Please set the object storage username in one of the following ways:"
  echo ""
  echo "  1. Add OBJECT_STORE_USERNAME to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the USERNAME environment variable directly"
  fail=1
fi

[ "$fail" -eq 1 ] && exit 1

# ── Launch ───────────────────────────────────────

exec minio "$@"
