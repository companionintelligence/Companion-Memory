#!/bin/sh
set -e

# ──────────────────────────────────────────────────
# Secrets-aware entrypoint for the object store (RustFS).
#
# Loads credentials from the secrets file when present, then falls back to
# environment variables set by Docker Compose.
#
# Maps the names the rest of Memory uses (OBJECT_STORE_USERNAME,
# OBJECT_STORE_PASSWORD) onto RustFS's own (RUSTFS_ACCESS_KEY,
# RUSTFS_SECRET_KEY), then drops to uid 10001 and execs the upstream
# entrypoint. That entrypoint starts `rustfs` and appends RUSTFS_VOLUMES.
#
# Priority: shell env  >  secrets file  >  (fail)
# ──────────────────────────────────────────────────

SECRETS_FILE="${SECRETS_FILE:-/run/secrets/.env.secrets}"
DATA_DIR="${RUSTFS_VOLUMES:-/data}"

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

export RUSTFS_ACCESS_KEY="$USERNAME"
export RUSTFS_SECRET_KEY="$PASSWORD"
unset USERNAME PASSWORD

# ── Validation ───────────────────────────────────

fail=0

if [ -z "$RUSTFS_SECRET_KEY" ]; then
  echo "Error: OBJECT_STORE_PASSWORD is not set."
  echo ""
  echo "Please set the object storage password in one of the following ways:"
  echo ""
  echo "  1. Add OBJECT_STORE_PASSWORD to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the PASSWORD environment variable directly"
  fail=1
fi

if [ -z "$RUSTFS_ACCESS_KEY" ]; then
  echo "Error: OBJECT_STORE_USERNAME is not set."
  echo ""
  echo "Please set the object storage username in one of the following ways:"
  echo ""
  echo "  1. Add OBJECT_STORE_USERNAME to the secrets file at $SECRETS_FILE, or"
  echo "  2. Set the USERNAME environment variable directly"
  fail=1
fi

[ "$fail" -eq 1 ] && exit 1

# ── Data directory ───────────────────────────────
#
# A single absolute path. A comma-separated RUSTFS_VOLUMES is a multi-drive
# layout this wrapper does not chown; set that only when every path is already
# writable by uid 10001.

case "$DATA_DIR" in
  /*)
    mkdir -p "$DATA_DIR/.rustfs/events" "$DATA_DIR/.rustfs/audit"
    if ! su-exec rustfs:rustfs test -w "$DATA_DIR"; then
      chown rustfs:rustfs "$DATA_DIR"
    fi
    if ! su-exec rustfs:rustfs test -w "$DATA_DIR/.rustfs"; then
      chown -R rustfs:rustfs "$DATA_DIR/.rustfs"
    fi
    ;;
esac

export RUSTFS_VOLUMES="$DATA_DIR"

exec su-exec rustfs:rustfs /entrypoint.sh "$@"
