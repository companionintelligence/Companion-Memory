#!/bin/sh
set -eu

# ──────────────────────────────────────────────────
# First-boot secret generation for Companion Intelligence.
#
# Creates a shared .env.secrets file on a Docker volume
# so all services can load credentials without hard-coding
# them in images or compose files.
#
# Idempotent — if the file already exists, permissions
# are fixed up and the script exits immediately.
# ──────────────────────────────────────────────────

SECRETS_FILE="${SECRETS_FILE:-/run/secrets/.env.secrets}"

random_password() {
  head -c 32 /dev/urandom | base64 | tr -d '/+=\n'
}

# Append a key that a later version of this script started requiring. Deployments
# that first booted before it existed keep their file (and every secret in it);
# they just gain the missing entry. Existing values are never rewritten — that
# would orphan data encrypted with the old key.
ensure_secret() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$SECRETS_FILE"; then
    echo "[bootstrap] Adding missing secret ${key} to ${SECRETS_FILE}"
    printf '%s=%s\n' "$key" "$value" >> "$SECRETS_FILE"
  fi
}

# ── Early Exit ───────────────────────────────────

if [ -f "$SECRETS_FILE" ]; then
  chmod 644 "$SECRETS_FILE"
  echo "[bootstrap] Secrets file exists at ${SECRETS_FILE}, skipping generation."
  ensure_secret POWERSYNC_DATABASE_USERNAME powersync
  ensure_secret POWERSYNC_DATABASE_PASSWORD "$(random_password)"
  exit 0
fi

# ── Generation ───────────────────────────────────

echo "[bootstrap] First boot detected — generating unique deployment secrets..."
mkdir -p "$(dirname "$SECRETS_FILE")"

# ── Random Values ────────────────────────────────

DB_ADMIN_PASSWORD=$(random_password)
DB_APP_PASSWORD=$(random_password)
DB_ORCH_PASSWORD=$(random_password)
DB_SYNC_PASSWORD=$(random_password)
S3_USERNAME=$(random_password)
S3_PASSWORD=$(random_password)
JWT_ACCESS_SECRET=$(head -c 64 /dev/urandom | base64 | tr -d '\n')
JWT_REFRESH_SECRET=$(head -c 64 /dev/urandom | base64 | tr -d '\n')
SESSION_PEPPER=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
ENCRYPTION_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
CSRF_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n')

# ── Write Secrets File ───────────────────────────

cat > "$SECRETS_FILE" <<EOF
# Companion Intelligence Secrets
#
# Auto-generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# These secrets are unique to this deployment. If lost, encrypted data
# stored with these keys becomes unrecoverable.

# ──────────────────────────────
# PostgreSQL Admin (superuser)
# ──────────────────────────────
DATABASE_ADMIN_USERNAME=postgres
DATABASE_ADMIN_PASSWORD=${DB_ADMIN_PASSWORD}
DATABASE_ADMIN_NAME=postgres

# ──────────────────────────────
# Application Database (Companion API & Summary)
# ──────────────────────────────
DATABASE_USERNAME=companion
DATABASE_PASSWORD=${DB_APP_PASSWORD}
DATABASE_NAME=companion

# ──────────────────────────────
# Orchestrator Database (Temporal)
# ──────────────────────────────
ORCHESTRATOR_DATABASE_USERNAME=temporal
ORCHESTRATOR_DATABASE_PASSWORD=${DB_ORCH_PASSWORD}
ORCHESTRATOR_DATABASE_NAME=temporal

# ──────────────────────────────
# PowerSync replication role (read-only, REPLICATION attribute)
# ──────────────────────────────
POWERSYNC_DATABASE_USERNAME=powersync
POWERSYNC_DATABASE_PASSWORD=${DB_SYNC_PASSWORD}

# ──────────────────────────────
# Object Store (MinIO)
# ──────────────────────────────
OBJECT_STORE_USERNAME=${S3_USERNAME}
OBJECT_STORE_PASSWORD=${S3_PASSWORD}

# ──────────────────────────────
# Authentication & Encryption
# ──────────────────────────────
AUTH_TOKEN_SECRET=${JWT_ACCESS_SECRET}
AUTH_REFRESH_TOKEN_SECRET=${JWT_REFRESH_SECRET}
AUTH_SESSION_PEPPER=${SESSION_PEPPER}
AUTH_FIELD_ENCRYPTION_KEY=${ENCRYPTION_KEY}
AUTH_CSRF_TOKEN_SECRET=${CSRF_SECRET}
EOF

chmod 644 "$SECRETS_FILE"
echo "[bootstrap] Secrets generated and stored at ${SECRETS_FILE}"
