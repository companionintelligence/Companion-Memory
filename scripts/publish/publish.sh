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
#   PORTAL_API           Portal API base URL           (default: https://portal.ci.localhost/api)
#   STORE_ADMIN_API_KEY  Admin key for publish API     (required)
#   REGISTRY_USERNAME    Registry login username       (required, unless GITHUB_TOKEN is set)
#   REGISTRY_PASSWORD    Registry login password       (required, unless GITHUB_TOKEN is set)
#   GITHUB_TOKEN         Token used as registry password fallback (e.g. inside GitHub Actions)
#   GITHUB_ACTOR         Username paired with GITHUB_TOKEN          (default: github-actions)
#   VERSION              Override version              (default: git tag or "latest")
#   SKIP_IMAGE_PUSH      Skip Step 3 (docker login + image push)    (default: false)

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
PORTAL_API="${PORTAL_API:-https://portal.ci.localhost/api}"
ADMIN_KEY="${STORE_ADMIN_API_KEY:-}"
SLUG="companion"

# Portal catalog registration (ingest → publish) is best-effort. Pushing the
# images to the registry is the part that actually matters for installs, so a
# missing / unreachable Portal must NOT abort the image push. When PORTAL_API
# or the admin key aren't configured (e.g. DEV_PORTAL_API unset in CI, or an
# images-only publish), we skip the Portal phases and still push images.
PORTAL_ENABLED=true
if [[ -z "${ADMIN_KEY}" || "${SKIP_PORTAL:-false}" == "true" ]]; then
  PORTAL_ENABLED=false
fi

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
# Local images are built by `make build ENV=production` as ci/<name>.
# Registry repos use companion/<name> as the public namespace.
# Parallel arrays instead of associative array (bash 3.2 compat).

IMAGE_LOCAL=(
  ci/api
  ci/database
  ci/gateway
  ci/object-store
  ci/orchestrator
  ci/summary-service
  ci/setup-database
  ci/setup-orchestrator
  ci/setup-secrets
  ci/hbpe-service
)
IMAGE_REMOTE=(
  companion/api
  companion/database
  companion/gateway
  companion/object-store
  companion/orchestrator
  companion/summary-service
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
      "name": "fix-db-permissions",
      "image": "busybox:latest",
      "restart": "no",
      "user": "root",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/db", "containerPath": "/var/lib/postgresql" }
      ],
      "command": ["sh", "-c", "chown -R 999:999 /var/lib/postgresql"]
    },
    {
      "name": "database",
      "image": "${reg}/companion/database:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/db", "containerPath": "/var/lib/postgresql" },
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
  local RESULT HTTP_CODE BODY STATUS
  if [[ "$PORTAL_ENABLED" == "true" ]]; then
    log "=== Step 2: Upload bundle → pending ==="

    # Non-fatal: a connection error (curl exits non-zero) or non-200 must not
    # abort the run — we degrade to image-only publish.
    RESULT=$(curl $CURL_OPTS -w '\n%{http_code}' -X POST "${PORTAL_API}/store/ingest" \
      -H "x-admin-key: ${ADMIN_KEY}" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@${BUNDLE}" 2>/dev/null) || RESULT=""

    HTTP_CODE=$(echo "$RESULT" | tail -1)
    BODY=$(echo "$RESULT" | sed '$d')
    STATUS=$(echo "$BODY" | jq -r '.status // empty' 2>/dev/null || echo "")

    if [[ "$HTTP_CODE" == "200" && "$STATUS" == "pending" ]]; then
      log "  HTTP ${HTTP_CODE} — status: pending"
    else
      log "  ⚠ Portal ingest failed (HTTP ${HTTP_CODE:-none}) at ${PORTAL_API}"
      log "    Skipping catalog registration — images will still be pushed."
      PORTAL_ENABLED=false
    fi
    log ""
  else
    log "=== Step 2: Upload bundle → pending (SKIPPED — Portal not configured) ==="
    log "  Set PORTAL_API + STORE_ADMIN_API_KEY to register the store bundle."
    log ""
  fi

  # ── Step 3: Tag and push images ────────────────────────────────────
  if [[ "${SKIP_IMAGE_PUSH:-false}" == "true" ]]; then
    log "=== Step 3: Tag and push Docker images (SKIPPED) ==="
    log "  SKIP_IMAGE_PUSH=true — assuming images already exist in ${REGISTRY}"
    log ""
  else
    log "=== Step 3: Tag and push Docker images ==="

    # Resolve registry credentials. Prefer explicit REGISTRY_USERNAME /
    # REGISTRY_PASSWORD, but fall back to GITHUB_TOKEN (with GITHUB_ACTOR or a
    # default username) so this script can run unmodified inside GitHub Actions.
    local REG_USER REG_PASS
    if [[ -n "${REGISTRY_USERNAME:-}" && -n "${REGISTRY_PASSWORD:-}" ]]; then
      REG_USER="${REGISTRY_USERNAME}"
      REG_PASS="${REGISTRY_PASSWORD}"
    elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
      REG_USER="${GITHUB_ACTOR:-github-actions}"
      REG_PASS="${GITHUB_TOKEN}"
    else
      fail "Registry credentials not set: provide REGISTRY_USERNAME and REGISTRY_PASSWORD, or GITHUB_TOKEN"
    fi

    logn "  Logging in to ${REGISTRY} as ${REG_USER} … "
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

      # Check local image exists. `make production` builds images tagged
      # :latest, which we then re-tag as ${REMOTE} (i.e. :${VERSION}) below.
      if ! docker image inspect "${LOCAL_IMAGE}:latest" > /dev/null 2>&1; then
        log "  ⚠ ${LOCAL_IMAGE}:latest not found locally — skipping"
        continue
      fi

      logn "  ${LOCAL_IMAGE}:latest → ${REMOTE} … "

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
  fi

  # ── Step 4: Publish (Phase 3) ──────────────────────────────────────
  if [[ "$PORTAL_ENABLED" == "true" ]]; then
    log "=== Step 4: Publish → published ==="

    RESULT=$(curl $CURL_OPTS -w '\n%{http_code}' -X POST \
      "${PORTAL_API}/store/publish/${SLUG}" \
      -H "x-admin-key: ${ADMIN_KEY}" 2>/dev/null) || RESULT=""

    HTTP_CODE=$(echo "$RESULT" | tail -1)
    BODY=$(echo "$RESULT" | sed '$d')
    STATUS=$(echo "$BODY" | jq -r '.status // empty' 2>/dev/null || echo "")

    if [[ "$HTTP_CODE" == "200" && "$STATUS" == "published" ]]; then
      log "  ✓ ${SLUG}@${VERSION} published!"
    else
      log "  ⚠ Portal publish failed (HTTP ${HTTP_CODE:-none}) — images are pushed but the catalog entry was not finalized."
      PORTAL_ENABLED=false
    fi
    log ""
  else
    log "=== Step 4: Publish → published (SKIPPED — Portal not configured) ==="
    log ""
  fi

  # ── Step 5: Verify / summary ───────────────────────────────────────
  if [[ "$PORTAL_ENABLED" == "true" ]]; then
    if ! $QUIET; then
      echo "=== Step 5: Verify store listing ==="
      curl $CURL_OPTS "${PORTAL_API}/store/${SLUG}" | jq '.' 2>/dev/null \
        || echo "  (listing endpoint returned non-JSON — but publish succeeded)"
      echo ""
      echo "✓ ${SLUG}@${VERSION} published to ${REGISTRY}"
    else
      echo "  ✓ ${SLUG}@${VERSION}"
    fi
  else
    echo "✓ Images for ${SLUG}@${VERSION} pushed to ${REGISTRY}."
    echo "  (Portal catalog registration was skipped — set PORTAL_API + STORE_ADMIN_API_KEY to enable.)"
  fi
}

main "$@"
