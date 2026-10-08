#!/usr/bin/env bash
set -euo pipefail

# ── CI-Server → CI-Portal Publish Script ───────────────────────────────
#
# Publishes CI-Server as a single app ("ci-memory") to a CI-Portal
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
#   VERSION              Override version              (default: git tag, else dev-<short-sha>)
#   SKIP_IMAGE_PUSH      Skip Step 3 (docker login + image push)    (default: false)
#   SKIP_PORTAL          Skip Portal ingest/publish (images only)   (default: false)
#   TAG_SUFFIX           Suffix appended to the pushed version tag, e.g. "-amd64".
#                        Used by the multi-arch publish workflow: each native
#                        build leg pushes :VERSION-<arch>, and merge-manifests.sh
#                        combines them into the :VERSION manifest list.
#   DIGEST_FILE          If set, append "<remote repo> <sha256 digest>" for every
#                        image pushed, and fail when a push reports no digest.
#                        merge-manifests.sh reads these (DIGESTS_DIR) so the
#                        release manifest names exactly what this run pushed,
#                        not whatever the tag points at by then.

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

# Slug is derived from the manifest's config.json `id` so it always matches the
# value the Portal ingest handler reads from the bundle. Keeping it in sync this
# way prevents Step 2 (ingest, keyed on config.json id) and Step 4 (publish,
# keyed on this slug) from ever disagreeing on which app is being published.
SLUG=$(jq -r '.id' "${SCRIPT_DIR}/manifest/config.json")
if [[ -z "$SLUG" || "$SLUG" == "null" ]]; then
  echo "  ✗ Could not read 'id' from ${SCRIPT_DIR}/manifest/config.json" >&2
  exit 1
fi

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

# Version: git tag (exact match) → fallback to a dev tag naming the commit.
#
# This must never fall back to "latest". The release pipeline reserves that tag
# for the newest release (see merge-manifests.sh PUSH_LATEST), and an untagged
# `make publish` against a real registry would otherwise overwrite it with a
# local dev build — which is exactly how companion/*:latest became a stale
# amd64-only orphan pointing at no release at all.
if [[ -z "${VERSION:-}" ]]; then
  VERSION=$(git -C "$REPO_ROOT" describe --tags --exact-match 2>/dev/null || true)
  if [[ -z "${VERSION}" ]]; then
    # Checked separately rather than inlined: `VERSION="dev-$(...)"` keeps the
    # literal prefix when the substitution fails, so a non-git checkout would
    # silently publish the malformed tag "dev-" instead of erroring.
    SHORT_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)
    if [[ -z "${SHORT_SHA}" ]]; then
      echo "  ✗ VERSION is unset and ${REPO_ROOT} is not a git checkout — pass VERSION=<tag> explicitly" >&2
      exit 1
    fi
    VERSION="dev-${SHORT_SHA}"
  fi
fi

# Strip the leading v exactly as publish.yml does — whatever the source, an
# explicit VERSION=v2026.7.27 included. Without this a local `make publish`
# tags images :v2026.7.27 while CI tags :2026.7.27 — two shapes for one
# release, which is how the registry ends up with tags nothing references.
VERSION="${VERSION#v}"


QUIET=false
for arg in "$@"; do
  [[ "$arg" == "-q" || "$arg" == "--quiet" ]] && QUIET=true
done

# ── Image Map ──────────────────────────────────────────────────────────
# Shared with merge-manifests.sh — see scripts/publish/images.sh.

# shellcheck source=scripts/publish/images.sh
source "${SCRIPT_DIR}/images.sh"

# ── Helpers ────────────────────────────────────────────────────────────

log() { $QUIET || echo "$@"; }
logn() { $QUIET || printf "%s" "$@"; }

fail() {
  echo "  ✗ $*" >&2
  exit 1
}

# ── Generate docker-compose.json ───────────────────────────────────────
#
# ⚠ HAND-MAINTAINED MIRROR OF docker-compose.production.yml. Nothing derives
# this heredoc from the compose model — the runtipi dynamic-compose schema is a
# different shape entirely (JSON, `services` as an array, camelCase keys,
# hostPath mounts instead of named volumes), so the two drift silently and only
# a store install ever shows it. It already had: the bundle shipped with NO
# `worker` service at all, which meant every store install ran the import
# queues (long synchronous parser stages) inside the same process serving HTTP
# — the split docker-compose.production.yml has had since CI_ROLE landed.
#
# ⚠ ADDING A SERVICE TO docker-compose.production.yml? ADD IT HERE TOO. A
# service that exists only there is a service store users never get.
#
# Drift closed at the same time, for the record: summary-service and
# hbpe-service now also wait on `setup-database` (see the NOTE beside them in
# docker-compose.yml — both connect as the `companion` role setup-database
# creates, so gating on `database: service_healthy` alone races role creation
# and crash-loops the sidecar), and gateway now waits for the api to be
# *healthy* rather than merely started, so a store install cannot serve 502s
# from the moment the container exists until Nest finishes booting.
#
# Differences from docker-compose.production.yml that are DELIBERATE, not drift:
#
#   * Volumes. Everything hangs off ${APP_DATA_DIR} hostPaths because that is
#     the only storage runtipi hands an app; the named volumes (db-data,
#     object-data, secrets) and the operator bind mounts (CI_IMPORT_WORK_DIR,
#     CI_REPO_DIR) have no equivalent here, so the api/worker get one /app-data
#     mount instead. The secrets volumes all map onto
#     ${APP_DATA_DIR}/data/secrets: production's master `secrets` volume is
#     that directory, mounted (read-write) into setup-secrets ONLY, and each
#     `secrets-<svc>` projection volume is its services/<svc> subdirectory —
#     where setup-secrets writes it (its SECRETS_PROJECTION_ROOT default,
#     /run/secrets/services) and which that service alone mounts at
#     /run/secrets. The <svc> names are the `project` calls in
#     infrastructure/setup-secrets/entrypoint.sh; mount a name that map does
#     not project and the service boots with an empty /run/secrets. The master
#     is 0600 root, so pointing a non-root reader (hbpe, summary) at it instead
#     is not a fallback: it cannot read it and exits. The gateway reads no
#     secrets and mounts none, as in production.
#   * `fix-db-permissions` exists only here: runtipi creates ${APP_DATA_DIR}
#     as root, and postgres:18.4-bookworm runs as uid 999.
#   * `setup-secrets` is production compose's `generate-secrets`, renamed after
#     its image (companion/setup-secrets).
#   * No `networks`, `logging`, `profiles`, `mem_limit`, `ports`: runtipi owns
#     all of those. `isMain`/`internalPort`/`addToMainNetwork` on the gateway
#     are runtipi-only keys with no compose counterpart.
#   * No hbpe-service `devices`/`group_add` — and this is no longer a
#     difference from docker-compose.production.yml at all: that file used to
#     declare /dev/kfd + /dev/dri unconditionally, which made every non-AMD
#     host refuse to start the service, so the passthrough was moved into
#     docker-compose.rocm.yml, an opt-in overlay a generic store host never
#     layers in. Nothing to mirror here; the bullet stays only so the next
#     person diffing this bundle against production does not go looking for it.
#   * Environment. Production reads SENTRY_*, LLM_API_* from the appliance
#     .env; a store install has no .env, so the bundle passes only what it can
#     point at inside /app-data (LLM_ENDPOINT_CONFIG_PATH and the three
#     CI_IMPORT_*_DIR paths below).
#   * The api healthCheck is production's, respelled: compose's `start_period`
#     is `startPeriod` here (v2 dynamic-compose schema, checked against
#     https://schemas.runtipi.io/v2/dynamic-compose.json — `test` there is a
#     STRING, never compose's ["CMD", …] array form, hence the shell-form
#     command). Getting a key name wrong fails bundle validation for every
#     installer, so mirror spellings from that schema, not from compose.
#   * The database healthCheck is production's, minus `init: true`: the
#     schema has no `init` key, so here the postmaster stays PID 1 and
#     inherits every orphan in the container. Postgres crash-restarts
#     every backend when one of those exits above 1 (docker-compose.yml's
#     database block has the measured case). Shell-form test strings run
#     under `sh -c`, and dash forks rather than exec'ing the last command,
#     so a probe that outran its timeout left pg_isready orphaned when Docker
#     killed the shell. The leading `exec` swaps the shell for pg_isready, so
#     the process Docker kills is the probe itself. This closes the probe
#     path only; an orphan from a `docker exec` shell can still reach the
#     postmaster until the schema grows `init`.
#
# Three things about the api/worker pair that are easy to break by halves:
#
#   1. `CI_ROLE` MUST be set on BOTH. It defaults to `all` (see
#      common/roles.ts), so a worker added next to an api that still defaults
#      to `all` gives two processes consuming the same queues — and the import
#      recovery sweep assumes exactly one worker.
#   2. The three CI_IMPORT_*_DIR paths MUST be set, to the SAME values, on
#      BOTH — and they must live under /app-data, the only mount the two
#      containers share. Their defaults (configuration.ts: uploadsDir
#      /var/lib/ci-import/uploads, scratchDir /var/tmp/ci-import, inboxDir
#      /var/lib/ci-import/inbox) are container-local, which is harmless for a
#      single `all` process and silently fatal once the halves split:
#      ImportUploadsController (HTTP, so the web half) writes the staged
#      archive to `<uploadsDir>/<dropId>/`, and the stage jobs that consume it
#      are `role: 'worker'` (import/constants.ts), so the worker would look for
#      those bytes in its own empty filesystem and every uploaded import would
#      fail with ENOENT. This is the same contract production compose states in
#      the worker's `${CI_IMPORT_WORK_DIR}:/var/lib/ci-import` comment — "both
#      halves must see one filesystem" — expressed with env instead of a mount
#      because /app-data is the only storage runtipi hands the app. Keep the
#      three siblings: configuration.ts rejects any one of them nested inside
#      another (uploads under the inbox would expose staged uploads to the
#      inbox scan).
#   3. The worker gets no healthCheck on purpose, exactly as in production
#      compose: it serves no port and nothing dependsOn it.
#
# KNOWN REMAINING DRIFT (deliberately left, needs more than a mirror edit):
#   * Production's gateway also waits on `object-store: service_healthy`. The
#     object-store image now carries its own HEALTHCHECK (`curl -f
#     http://localhost:9000/health`, see infrastructure/object-store/Dockerfile),
#     so only the gateway's dependsOn entry is missing here — but an unproven
#     wait would leave the gateway stuck forever on a store install, so it is
#     left to whoever can test a real install rather than guessed at here.
#   * The /app-data mounts see ${APP_DATA_DIR}/data/secrets, so on a store
#     install the per-service isolation is partial: api and worker (root) can
#     read the master through it, and summary-service (uid 1000) every 0644
#     projection, the api's AUTH_* secrets included. summary mounts /app-data
#     only for llm-endpoint.json, which the api writes; a single-file bind is
#     not the fix (Docker creates a DIRECTORY at an absent host path, and the
#     api would then fail to write it). Moving that file out from beside
#     data/secrets is an api + summary path change, not a mirror edit.
#
# It is also kept in step with CI-Marketplace's apps/ci-memory/docker-compose.json,
# with one deliberate exception: the database volume.
#
# CI-Marketplace mounts ${APP_DATA_DIR}/data/db at /home/postgres/pgdata and
# chowns it to 1000. Those are timescale/timescaledb-ha (Spilo) conventions,
# left over from the base image infrastructure/database/Dockerfile used before
# the PG18 upgrade. It is now postgres:18.4-bookworm, where PGDATA lives under
# /var/lib/postgresql and the server runs as uid 999 — the values below. Do not
# "resolve" that difference by copying CI-Marketplace's; they no longer match
# the image, and a database that mounts its volume somewhere PGDATA isn't keeps
# its real data in the container layer. See issue #1745.

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
      "addToMainNetwork": true,
      "restart": "unless-stopped",
      "dependsOn": {
        "api": { "condition": "service_healthy" }
      }
    },
    {
      "name": "api",
      "image": "${reg}/companion/api:${ver}",
      "restart": "unless-stopped",
      "environment": [
        { "key": "LLM_ENDPOINT_CONFIG_PATH", "value": "/app-data/data/llm-endpoint.json" },
        { "key": "CI_ROLE", "value": "web" },
        { "key": "CI_IMPORT_UPLOADS_DIR", "value": "/app-data/data/import-work/uploads" },
        { "key": "CI_IMPORT_SCRATCH_DIR", "value": "/app-data/data/import-work/scratch" },
        { "key": "CI_IMPORT_INBOX_DIR", "value": "/app-data/data/import-work/inbox" }
      ],
      "extraHosts": ["host.docker.internal:host-gateway"],
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}", "containerPath": "/app-data" },
        { "hostPath": "\${APP_DATA_DIR}/data/secrets/services/api", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "healthCheck": {
        "test": "curl -f http://localhost:3030/health",
        "interval": "10s",
        "timeout": "5s",
        "retries": 5,
        "startPeriod": "30s"
      },
      "dependsOn": {
        "migrate-database": { "condition": "service_completed_successfully" },
        "database": { "condition": "service_healthy" }
      }
    },
    {
      "name": "worker",
      "image": "${reg}/companion/api:${ver}",
      "restart": "unless-stopped",
      "environment": [
        { "key": "CI_ROLE", "value": "worker" },
        { "key": "LLM_ENDPOINT_CONFIG_PATH", "value": "/app-data/data/llm-endpoint.json" },
        { "key": "CI_IMPORT_UPLOADS_DIR", "value": "/app-data/data/import-work/uploads" },
        { "key": "CI_IMPORT_SCRATCH_DIR", "value": "/app-data/data/import-work/scratch" },
        { "key": "CI_IMPORT_INBOX_DIR", "value": "/app-data/data/import-work/inbox" }
      ],
      "extraHosts": ["host.docker.internal:host-gateway"],
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}", "containerPath": "/app-data" },
        { "hostPath": "\${APP_DATA_DIR}/data/secrets/services/api", "containerPath": "/run/secrets", "readOnly": true }
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
        { "hostPath": "\${APP_DATA_DIR}/data/secrets/services/database", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn" : {
        "fix-db-permissions": { "condition": "service_completed_successfully" },
        "setup-secrets": { "condition": "service_completed_successfully" }
      },
      "healthCheck": {
        "test": "exec pg_isready -U postgres -d postgres",
        "interval": "5s",
        "timeout": "10s",
        "retries": 5
      }
    },
    {
      "name": "object-store",
      "image": "${reg}/companion/object-store:${ver}",
      "restart": "unless-stopped",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/objects", "containerPath": "/data/objects" },
        { "hostPath": "\${APP_DATA_DIR}/data/secrets/services/object-store", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "setup-secrets": { "condition": "service_completed_successfully" }
      }
    },
    {
      "name": "summary-service",
      "image": "${reg}/companion/summary-service:${ver}",
      "restart": "unless-stopped",
      "extraHosts": ["host.docker.internal:host-gateway"],
      "environment": [
        { "key": "LLM_ENDPOINT_CONFIG_PATH", "value": "/app-data/data/llm-endpoint.json" }
      ],
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}", "containerPath": "/app-data", "readOnly": true },
        { "hostPath": "\${APP_DATA_DIR}/data/secrets/services/summary", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "database": { "condition": "service_healthy" },
        "setup-database": { "condition": "service_completed_successfully" },
        "setup-secrets": { "condition": "service_completed_successfully" }
      }
    },
    {
      "name": "setup-database",
      "image": "${reg}/companion/setup-database:${ver}",
      "restart": "no",
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets/services/setup-database", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "database": { "condition": "service_healthy" },
        "setup-secrets": { "condition": "service_completed_successfully" }
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
        { "hostPath": "\${APP_DATA_DIR}/data/secrets/services/hbpe", "containerPath": "/run/secrets", "readOnly": true }
      ],
      "dependsOn": {
        "database": { "condition": "service_healthy" },
        "setup-database": { "condition": "service_completed_successfully" },
        "setup-secrets": { "condition": "service_completed_successfully" }
      }
    },
    {
      "name": "migrate-database",
      "image": "${reg}/companion/api:${ver}",
      "restart": "no",
      "command": ["yarn", "migrate"],
      "volumes": [
        { "hostPath": "\${APP_DATA_DIR}/data/secrets/services/api", "containerPath": "/run/secrets", "readOnly": true }
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

# ── Check the generated bundle ─────────────────────────────────────────
#
# Settings a store bundle must never carry, checked on what generate_compose
# actually emitted rather than on its source text.
#
# ENABLE_REQUIRE_SIGNUP_CODES: a store install keeps the server default, where
# every account after the first needs an invite code. The bundle used to set it
# to "false", a workaround from before the first account on an empty appliance
# was exempt (#2594). It meant anyone who could reach an exposed install could
# register, and the next signup after the owner's account was deleted became
# the administrator. CI-Marketplace dropped the same line in 992f29ad. Any
# value is refused, not just "false": the default is the only correct setting
# here, and a later "true" would only hide a future flip back.
check_bundle() {
  local compose="$1"
  local hits

  # Every string in the document, keys included, so the variable is found
  # whether it is written as {"key": ...}, "NAME=value" or an object key.
  hits=$(jq '[(.. | strings), (paths | .[] | strings)]
    | map(select(. == "ENABLE_REQUIRE_SIGNUP_CODES" or startswith("ENABLE_REQUIRE_SIGNUP_CODES=")))
    | length' "$compose") || fail "could not read ${compose} as JSON"

  if [[ "$hits" != "0" ]]; then
    fail "the generated bundle sets ENABLE_REQUIRE_SIGNUP_CODES; store installs must keep the server default (signup codes required)"
  fi
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

  # The tarball gets a mktemp -d directory, not a file template: BSD mktemp
  # (macOS) randomizes only TRAILING X's, so /tmp/bundle-XXXXXX.tar.gz is
  # created as that literal path. Concurrent runs collide on it, and a run
  # killed before the trap fires leaves it behind to fail every later run with
  # "File exists".
  BUNDLE_DIR=$(mktemp -d)
  BUNDLE_OUT_DIR=$(mktemp -d)
  BUNDLE="${BUNDLE_OUT_DIR}/bundle.tar.gz"
  trap "rm -rf '$BUNDLE_DIR' '$BUNDLE_OUT_DIR'" EXIT

  # Copy static manifest files
  cp -r "${SCRIPT_DIR}/manifest/." "${BUNDLE_DIR}/"

  # Patch version in config.json
  local CONFIG="${BUNDLE_DIR}/config.json"
  local TMP_CONFIG="${BUNDLE_DIR}/config.json.tmp"
  jq --arg v "$VERSION" '.version = $v' "$CONFIG" > "$TMP_CONFIG" && mv "$TMP_CONFIG" "$CONFIG"

  # Generate docker-compose.json
  generate_compose "$REGISTRY" "$VERSION" > "${BUNDLE_DIR}/docker-compose.json"
  check_bundle "${BUNDLE_DIR}/docker-compose.json"

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
      local REMOTE="${REGISTRY}/${REPO}:${VERSION}${TAG_SUFFIX:-}"

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

        if [[ -n "${DIGEST_FILE:-}" ]]; then
          # `docker push` ends with "<tag>: digest: sha256:<hex> size: <n>".
          # That is the digest the registry stored for this push, read from
          # the push itself rather than from a later lookup of the tag.
          local DIGEST
          DIGEST=$(printf '%s\n' "${PUSH_OUTPUT}" \
            | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' | tail -n 1)
          if [[ -z "${DIGEST}" ]]; then
            echo "${PUSH_OUTPUT}" >&2
            fail "pushed ${REMOTE} but found no digest in the push output"
          fi
          echo "${REPO} ${DIGEST}" >> "${DIGEST_FILE}"
          log "    ${DIGEST}"
        fi
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
      -H "x-admin-key: ${ADMIN_KEY}" \
      -H "Content-Type: application/json" \
      -d '{"channels":["prod"]}' 2>/dev/null) || RESULT=""

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
