#!/usr/bin/env bash
set -euo pipefail

# ── CI-Server → CI-Portal Publish Script ───────────────────────────────
#
# Publishes CI-Server as a single app ("companion") to a CI-Portal
# store instance using the three-phase publish workflow:
#
#   Phase 1: POST /api/store/ingest        (upload .tar.gz bundle → pending)
#   Phase 2: docker push                   (push images to registry)
#   Phase 3: POST /api/store/publish/:slug  (pending → published)
#
# Usage:
#   ./publish.sh                    # defaults for local dev
#   ./publish.sh -q                 # quiet mode
#   REGISTRY=portal.prod.example.com ./publish.sh
#
# Environment:
#   REGISTRY             Docker registry host          (default: portal.ci.localhost)
#   PORTAL_API           Portal API base URL           (default: https://portal.ci.localhost)
#   STORE_ADMIN_API_KEY  Admin key for publish API     (required)
#   REGISTRY_USERNAME    Registry login username         (required)
#   REGISTRY_PASSWORD    Registry login password         (required)
#   VERSION              Override version               (default: git tag or "latest")

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source .env if STORE_ADMIN_API_KEY is not already set
if [[ -z "${STORE_ADMIN_API_KEY:-}" && -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +a
fi

# ── Configuration ──────────────────────────────────────────────────────

REGISTRY="${REGISTRY:-portal.ci.localhost}"
PORTAL_API="${PORTAL_API:-https://portal.ci.localhost}"
ADMIN_KEY="${STORE_ADMIN_API_KEY:?STORE_ADMIN_API_KEY must be set}"
SLUG="companion"

# Allow insecure TLS only for local development
if [[ "$REGISTRY" == *".localhost" || "$REGISTRY" == "localhost"* ]]; then
  CURL_OPTS="-sk"
else
  CURL_OPTS="-s"
fi

# Version: git tag (exact match) → fallback to "latest"
if [[ -z "${VERSION:-}" ]]; then
  VERSION=$(git -C "$REPO_ROOT" describe --tags --exact-match 2>/dev/null || echo "latest")
fi

QUIET=false
for arg in "$@"; do
  [[ "$arg" == "-q" || "$arg" == "--quiet" ]] && QUIET=true
done

# ── Image Map ──────────────────────────────────────────────────────────
# Maps: local-image-name → registry-repo-name
#
# Local images are built by `make build-production` as ci/<name>.
# Registry repos use companion/<name> as the public namespace.
# Parallel arrays instead of associative array (bash 3.2 compat).

IMAGE_LOCAL=(
  ci/api
  ci/database
  ci/gateway
  ci/mcp
  ci/object-store
  ci/orchestrator
  ci/stt-service
  ci/summary-service
  ci/tts-service
  ci/setup-database
  ci/setup-orchestrator
  ci/setup-secrets
  ci/hbpe-service
)
IMAGE_REMOTE=(
  companion/api
  companion/database
  companion/gateway
  companion/mcp
  companion/object-store
  companion/orchestrator
  companion/stt-service
  companion/summary-service
  companion/tts-service
  companion/setup-database
  companion/setup-orchestrator
  companion/setup-secrets
  companion/hbpe-service
)

# ── Helpers ────────────────────────────────────────────────────────────

log() { $QUIET || echo "$@"; }
logn() { $QUIET || printf "%s" "$@"; }

fail() {
  echo "  ✗ $*" >&2
  exit 1
}

# ── Generate docker-compose.json ───────────────────────────────────────

generate_compose() {
  local reg="$1"
  local ver="$2"

  cat <<COMPOSE_EOF
{
  "schemaVersion": 2,
  "\$schema": "https://schemas.runtipi.io/v2/dynamic-compose.json",
  "services": [
    {
      "name": "gateway",
      "image": "${reg}/companion/gateway:${ver}",
      "isMain": true,
      "internalPort": 8642,
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "api": { "condition": "service_started" }
      }
    },
    {
      "name": "api",
      "image": "${reg}/companion/api:${ver}",
      "restart": "unless-stopped",
      "extraHosts": ["host.docker.internal:host-gateway"],
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "migrate-database": { "condition": "service_completed_successfully" },
        "database": { "condition": "service_healthy" }
      }
    },
    {
      "name": "mcp",
      "image": "${reg}/companion/mcp:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "environment": {
        "CI_API_BASE_URL": "http://api:3030"
      },
      "dependsOn": {
        "api": { "condition": "service_started" }
      }
    },
    {
      "name": "fix-db-permissions",
      "image": "busybox:latest",
      "restart": "no",
      "user": "root",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/db", "containerPath": "/home/postgres/pgdata/data" }
      ],
      "command": ["sh", "-c", "chown -R 1000:1000 /home/postgres/pgdata/data"]
    },
    {
      "name": "database",
      "image": "${reg}/companion/database:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/db", "containerPath": "/home/postgres/pgdata/data" },
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn" : {
        "fix-db-permissions": { "condition": "service_completed_successfully" }
      },
      "healthCheck": {
        "test": "pg_isready",
        "interval": "5s",
        "timeout": "5s",
        "retries": 5
      }
    },
    {
      "name": "object-store",
      "image": "${reg}/companion/object-store:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/objects", "containerPath": "/data/objects" },
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ]
    },
    {
      "name": "orchestrator",
      "image": "${reg}/companion/orchestrator:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "setup-orchestrator": { "condition": "service_completed_successfully" },
        "database": { "condition": "service_healthy" }
      }
    },
    {
      "name": "stt-service",
      "image": "${reg}/companion/stt-service:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/stt-models", "containerPath": "/app/models" },
        { "hostPath": "\${APP_DATA_DIR}/data/stt-cache", "containerPath": "/root/.cache" }
      ]
    },
    {
      "name": "summary-service",
      "image": "${reg}/companion/summary-service:${ver}",
      "restart": "unless-stopped",
      "extraHosts": ["host.docker.internal:host-gateway"],
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "database": { "condition": "service_healthy" },
        "orchestrator": { "condition": "service_started" }
      }
    },
    {
      "name": "tts-service",
      "image": "${reg}/companion/tts-service:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/tts-models", "containerPath": "/app/models" },
        { "hostPath": "\${APP_DATA_DIR}/data/tts-cache", "containerPath": "/root/.cache" }
      ]
    },
    {
      "name": "setup-database",
      "image": "${reg}/companion/setup-database:${ver}",
      "restart": "no",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "database": { "condition": "service_healthy" }
      }
    },
    {
      "name": "setup-orchestrator",
      "image": "${reg}/companion/setup-orchestrator:${ver}",
      "restart": "no",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "setup-database": { "condition": "service_completed_successfully" },
        "database": { "condition": "service_healthy" }
      }
    },
    {
      "name": "setup-secrets",
      "image": "${reg}/companion/setup-secrets:${ver}",
      "restart": "no",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets" }
      ]
    },
    {
      "name": "hbpe-service",
      "image": "${reg}/companion/hbpe-service:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/hbpe-models", "containerPath": "/app/models" },
        { "hostPath": "\${APP_DATA_DIR}/data/hbpe-corpus", "containerPath": "/app/data" },
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "database": { "condition": "service_healthy" },
        "orchestrator": { "condition": "service_started" }
      }
    },
    {
      "name": "migrate-database",
      "image": "${reg}/companion/api:${ver}",
      "restart": "no",
      "command": ["yarn", "migrate"],
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "setup-secrets": { "condition": "service_completed_successfully" },
        "database": { "condition": "service_healthy" }
      }
    }
  ]
}
COMPOSE_EOF
}

# ── Main ───────────────────────────────────────────────────────────────

main() {
  if ! $QUIET; then
    echo "╔══════════════════════════════════════╗"
    echo "║  CI-Server → CI-Portal Publish       ║"
    echo "║  ${SLUG}@${VERSION}"
    echo "║  Registry: ${REGISTRY}"
    echo "╚══════════════════════════════════════╝"
    echo ""
  else
    echo "Publishing ${SLUG}@${VERSION} → ${REGISTRY} …"
  fi

  # ── Step 1: Prepare bundle ──────────────────────────────────────────
  log "=== Step 1: Prepare app bundle ==="

  BUNDLE_DIR=$(mktemp -d)
  BUNDLE=$(mktemp /tmp/bundle-XXXXXX.tar.gz)
  trap "rm -rf '$BUNDLE_DIR' '$BUNDLE'" EXIT

  # Copy static manifest files
  cp -r "${SCRIPT_DIR}/manifest/." "${BUNDLE_DIR}/"

  # Patch version in config.json
  local CONFIG="${BUNDLE_DIR}/config.json"
  local TMP_CONFIG="${BUNDLE_DIR}/config.json.tmp"
  jq --arg v "$VERSION" '.version = $v' "$CONFIG" > "$TMP_CONFIG" && mv "$TMP_CONFIG" "$CONFIG"

  # Generate docker-compose.json
  generate_compose "$REGISTRY" "$VERSION" > "${BUNDLE_DIR}/docker-compose.json"

  log "  config.json version: $(jq -r .version "$CONFIG")"
  log "  docker-compose.json: $(jq '.services | length' "${BUNDLE_DIR}/docker-compose.json") services"

  log ${BUNDLE_DIR}
  # Create .tar.gz (BUNDLE is outside BUNDLE_DIR, so no self-referencing)
  log ${BUNDLE}
  tar -czf "$BUNDLE" -C "$BUNDLE_DIR" .

  log "  Bundle size: $(du -h "$BUNDLE" | cut -f1)"
  log ""

  # ── Step 2: Upload bundle (Phase 1) ────────────────────────────────
  log "=== Step 2: Upload bundle → pending ==="

  local RESULT HTTP_CODE BODY STATUS
  RESULT=$(curl $CURL_OPTS -w '\n%{http_code}' -X POST "${PORTAL_API}/api/store/ingest" \
    -H "x-admin-key: ${ADMIN_KEY}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${BUNDLE}")

  HTTP_CODE=$(echo "$RESULT" | tail -1)
  BODY=$(echo "$RESULT" | sed '$d')

  if [[ "$HTTP_CODE" != "200" ]]; then
    log "  HTTP ${HTTP_CODE}"
    log "$BODY"
    fail "Upload failed (HTTP ${HTTP_CODE})"
  fi

  STATUS=$(echo "$BODY" | jq -r '.status // empty')
  if [[ "$STATUS" != "pending" ]]; then
    log "$BODY"
    fail "Expected status=pending, got: ${STATUS}"
  fi

  log "  HTTP ${HTTP_CODE} — status: pending"
  log ""

  # ── Step 3: Tag and push images ────────────────────────────────────
  log "=== Step 3: Tag and push Docker images ==="

  local REG_USER="${REGISTRY_USERNAME:?REGISTRY_USERNAME must be set}"
  local REG_PASS="${REGISTRY_PASSWORD:?REGISTRY_PASSWORD must be set}"

  logn "  Logging in to ${REGISTRY} … "
  local LOGIN_OUTPUT
  if LOGIN_OUTPUT=$(echo "${REG_PASS}" | docker login "${REGISTRY}" -u "${REG_USER}" --password-stdin 2>&1); then
    log "✓"
  else
    log "✗"
    echo "$LOGIN_OUTPUT" >&2
    fail "docker login to ${REGISTRY} failed"
  fi

  local PUSH_FAILED=0 PUSH_SKIPPED=0 PUSH_COUNT=0
  for i in $(seq 0 $((${#IMAGE_LOCAL[@]} - 1))); do
    local LOCAL_IMAGE="${IMAGE_LOCAL[$i]}"
    local REPO="${IMAGE_REMOTE[$i]}"
    local REMOTE="${REGISTRY}/${REPO}:${VERSION}"

    # Check local image exists
    if ! docker image inspect "${LOCAL_IMAGE}:latest" > /dev/null 2>&1; then
      log "  ⚠ ${LOCAL_IMAGE}:latest not found locally — skipping"
      continue
    fi

    logn "  ${LOCAL_IMAGE} → ${REMOTE} … "

    docker image tag "${LOCAL_IMAGE}:latest" "${REMOTE}"
    if PUSH_OUTPUT=$(docker image push "${REMOTE}" 2>&1); then
      log "✓"
      PUSH_COUNT=$((PUSH_COUNT + 1))
    else
      log "✗"
      echo "$PUSH_OUTPUT" >&2
      PUSH_FAILED=$((PUSH_FAILED + 1))
    fi
  done

  if [[ $PUSH_FAILED -gt 0 ]]; then
    fail "${PUSH_FAILED} image(s) failed to push"
  fi

  log "  Pushed: ${PUSH_COUNT}, skipped: ${PUSH_SKIPPED}"
  log ""

  # ── Step 4: Publish (Phase 3) ──────────────────────────────────────
  log "=== Step 4: Publish → published ==="

  RESULT=$(curl $CURL_OPTS -w '\n%{http_code}' -X POST \
    "${PORTAL_API}/api/store/publish/${SLUG}" \
    -H "x-admin-key: ${ADMIN_KEY}")

  HTTP_CODE=$(echo "$RESULT" | tail -1)
  BODY=$(echo "$RESULT" | sed '$d')

  if [[ "$HTTP_CODE" != "200" ]]; then
    log "  HTTP ${HTTP_CODE}"
    log "$BODY"
    fail "Finalize failed (HTTP ${HTTP_CODE})"
  fi

  STATUS=$(echo "$BODY" | jq -r '.status // empty')
  if [[ "$STATUS" != "published" ]]; then
    log "$BODY"
    fail "Expected status=published, got: ${STATUS}"
  fi

  log "  ✓ ${SLUG}@${VERSION} published!"
  log ""

  # ── Step 5: Verify store listing ───────────────────────────────────
  if ! $QUIET; then
    echo "=== Step 5: Verify store listing ==="
    curl $CURL_OPTS "${PORTAL_API}/api/store/${SLUG}" | jq '.' 2>/dev/null \
      || echo "  (listing endpoint returned non-JSON — but publish succeeded)"
    echo ""
    echo "✓ ${SLUG}@${VERSION} published to ${REGISTRY}"
  else
    echo "  ✓ ${SLUG}@${VERSION}"
  fi
}

main "$@"
