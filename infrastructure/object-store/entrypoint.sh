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
DATA_DIR="${RUSTFS_VOLUMES:-/data/objects}"

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
# layout this wrapper neither checks nor chowns; set that only when every path
# is a mounted volume already writable by uid 10001.

case "$DATA_DIR" in
  /*)
    # Must be a mount point. Otherwise the upstream entrypoint mkdirs it inside
    # the image's anonymous /data volume and RustFS serves an empty store: the
    # API recreates its bucket, every existing file 404s, and new uploads land
    # in a volume that is discarded with the container. mountinfo, not
    # `mountpoint`: that compares device numbers, and a bind mount from the
    # filesystem Docker's own volumes live on shares one.
    if ! awk -v d="$DATA_DIR" '$5 == d { found = 1 } END { exit !found }' /proc/self/mountinfo; then
      echo "Error: $DATA_DIR is not a mounted volume."
      echo ""
      echo "Mount the object store's volume at $DATA_DIR (compose:"
      echo "object-data:$DATA_DIR). Refusing to start on the container's own"
      echo "filesystem, where objects would be lost when it is recreated."
      exit 1
    fi

    mkdir -p "$DATA_DIR/.rustfs/events" "$DATA_DIR/.rustfs/audit"

    # Anything not owned by rustfs is readable but not writable by it: PUTs
    # fail with "File access denied" and DELETEs with AccessDenied. MinIO ran
    # as root, so this is every object on a volume it wrote.
    #
    # The full walk costs ~0.9 s warm / ~1.25 s cold per ~47k objects on NVMe
    # (far more on slower disks), so it runs once, then again only if MinIO
    # has run on this volume since — a rollback writes root-owned objects
    # again, and MinIO rewrites .minio.sys on every start. Files a root
    # process drops in here some other way are not caught; delete the marker
    # to force a re-check.
    OWNERSHIP_MARKER="$DATA_DIR/.rustfs/ownership-checked"
    if [ ! -f "$OWNERSHIP_MARKER" ] || {
      [ -d "$DATA_DIR/.minio.sys" ] &&
        [ -n "$(find "$DATA_DIR/.minio.sys" -newer "$OWNERSHIP_MARKER" -print -quit)" ]
    }; then
      if [ -n "$(find "$DATA_DIR" -xdev \( ! -user rustfs -o ! -group rustfs \) -print -quit)" ]; then
        echo "Giving rustfs ownership of $DATA_DIR (found files it does not own)"
        chown -R rustfs:rustfs "$DATA_DIR"
      fi
      su-exec rustfs:rustfs touch "$OWNERSHIP_MARKER"
    fi
    ;;
esac

export RUSTFS_VOLUMES="$DATA_DIR"

exec su-exec rustfs:rustfs /entrypoint.sh "$@"
