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

# ── Early Exit ───────────────────────────────────

if [ -f "$SECRETS_FILE" ]; then
  chmod 644 "$SECRETS_FILE"
  echo "[bootstrap] Secrets file exists at ${SECRETS_FILE}, skipping generation."
  exit 0
fi

# ── Generation ───────────────────────────────────

echo "[bootstrap] First boot detected — generating unique deployment secrets..."
mkdir -p "$(dirname "$SECRETS_FILE")"

# ── Random Values ────────────────────────────────

DB_ADMIN_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
DB_APP_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
DB_ORCH_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
S3_USERNAME=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
S3_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
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
