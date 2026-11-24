#!/usr/bin/env bash
# One-off: run locally built CI-Server api/gateway/hbpe/summary against Hub-managed ci-memory prod data.
# See docs/runbooks/one-off-prod-data-testing.md
set -euo pipefail

PR_TAG="${PR_TAG:-pr-onboarding-test}"
# Hub compose does not pass GPU devices into hbpe-service, so the image that
# lands on the box must be the CPU Dockerfile. Override GPU=rocm|cuda only if
# you also add device mounts in the override file.
GPU="${GPU:-cpu}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# shellcheck source=hub-pr-test-common.sh
source "$(dirname "$0")/hub-pr-test-common.sh"

API_IMAGE="ghcr.io/companionintelligence/companion/api:${PR_TAG}"
GATEWAY_IMAGE="ghcr.io/companionintelligence/companion/gateway:${PR_TAG}"
HBPE_IMAGE="ghcr.io/companionintelligence/companion/hbpe-service:${PR_TAG}"
SUMMARY_IMAGE="ghcr.io/companionintelligence/companion/summary-service:${PR_TAG}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--frontend] [--skip-build] [--skip-migrate]

  Builds (unless --skip-build) and swaps ci-memory api + gateway + hbpe-service
  + summary-service to local images tagged ${PR_TAG}. The image override goes in
  the Hub's user compose override for ci-memory, which the Hub applies on every
  start, so the swap survives a Hub restart or a reboot. An operator override
  already there is moved aside and put back by the rollback script.

  --frontend        Rebuild only the web UI + gateway image, recreate gateway,
                    skip migrate. Use this for chrome/CSS/JS-only swaps.

Environment:
  PR_TAG            Image tag for local test images (default: pr-onboarding-test)
  GPU               HBPE Dockerfile variant (default: cpu — Hub does not pass GPU devices)
  HUB_CONTAINER     Hub container name (default: ci-hub, or ci-os-hub on older Hubs)
  ROOT_FOLDER_HOST  Hub data root (default: read from the Hub container's mounts,
                    else ~/.local/share/companion-hub)

Rollback: $(dirname "$0")/hub-pr-test-rollback.sh
EOF
}

SKIP_BUILD=0
SKIP_MIGRATE=0
FRONTEND_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --frontend) FRONTEND_ONLY=1; SKIP_MIGRATE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-migrate) SKIP_MIGRATE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

require_app_env

# An operator's own user compose override is moved aside while a swap is in
# place and there is room for one. Checked before the build (which takes
# minutes) and again just before the move.
check_backup_slot() {
  if [[ -f "$USER_COMPOSE_HOST" ]] && ! is_pr_test_override "$USER_COMPOSE_HOST" && [[ -e "$USER_COMPOSE_BACKUP_HOST" ]]; then
    echo "Both $USER_COMPOSE_HOST and $USER_COMPOSE_BACKUP_HOST exist and neither was written by this script." >&2
    echo "Merge or remove one of them, then rerun." >&2
    exit 1
  fi
}
check_backup_slot

RECREATE="api gateway hbpe-service summary-service"
if [[ "$FRONTEND_ONLY" -eq 1 ]]; then
  RECREATE="gateway"
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  if [[ "$FRONTEND_ONLY" -eq 1 ]]; then
    echo "==> Building web frontend + gateway image in ${REPO_ROOT}..."
    (cd "$REPO_ROOT/frontend/apps/web" && yarn build)
    (cd "$REPO_ROOT" && docker build -f infrastructure/gateway/Dockerfile -t ci/gateway:latest .)
  else
    echo "==> Building production images (GPU=${GPU}) in ${REPO_ROOT}..."
    (cd "$REPO_ROOT" && make build ENV=production GPU="$GPU")
  fi
fi

echo "==> Tagging local images as ${PR_TAG}..."
if [[ "$FRONTEND_ONLY" -eq 0 ]]; then
  docker tag ci/api:latest "$API_IMAGE"
  docker tag ci/hbpe-service:latest "$HBPE_IMAGE"
  docker tag ci/summary-service:latest "$SUMMARY_IMAGE"
fi
docker tag ci/gateway:latest "$GATEWAY_IMAGE"

# env_file must be declared on the services for the user-config overlay
# (NODE_OPTIONS, LLM endpoints, …) to reach the container environment —
# CLI --env-file only feeds compose variable substitution.
ENV_FILE_YAML="    env_file:
      - ${HUB_APP_ENV}"
if [[ -f "$USER_ENV_HOST" ]]; then
  ENV_FILE_YAML="${ENV_FILE_YAML}
      - ${HUB_USER_ENV}"
fi

mkdir -p "$USER_CONFIG_DIR_HOST"

# The override is built in a temporary file beside the user compose override and
# the migration and recreate below run against it. It replaces the user compose
# override only once both have worked, so a failed run leaves the Hub starting
# Memory the way it did before.
OVERRIDE_TMP="$(mktemp "${USER_COMPOSE_HOST}.XXXXXX")"
on_exit() {
  local status=$?
  if [[ -n "$OVERRIDE_TMP" ]]; then
    rm -f "$OVERRIDE_TMP"
    if [[ "$status" -ne 0 ]]; then
      echo "Deploy failed. $USER_COMPOSE_HOST was left as it was." >&2
      echo "Services recreated before the failure keep the test images until the Hub next starts Memory or you run hub-pr-test-rollback.sh." >&2
    fi
  fi
}
trap on_exit EXIT

# The Hub applies this override every time it starts Memory, so it must pin
# what runs after this swap: all four services in a full swap; in --frontend
# mode the gateway, plus whatever an earlier full swap left running. A tag this
# run did not create exists only on the machine that built it and the Hub
# would try to pull it.
keep_swapped() {
  [[ "$FRONTEND_ONLY" -eq 0 ]] ||
    [[ "$(docker inspect -f '{{.Config.Image}}' "${COMPOSE_PROJECT}-$1-1" 2>/dev/null || true)" == "$2" ]]
}

PINNED="gateway"
{
  echo "${PR_TEST_MARKER}. hub-pr-test-rollback.sh removes it and puts back any file it replaced."
  echo "services:"
  if keep_swapped api "$API_IMAGE"; then
    PINNED="api ${PINNED}"
    cat <<EOF
  api:
    image: ${API_IMAGE}
    # Checkout can be ahead of the live DB. Do not apply those migrations
    # from this script unless the operator passes no --skip-migrate AND
    # has confirmed the SQL. Until then the API must boot anyway.
    environment:
      CI_SKIP_SCHEMA_CHECK: "1"
${ENV_FILE_YAML}
EOF
    # The Hub runs migrate-database every time it starts Memory. Pinning it after
    # --skip-migrate or --frontend would apply the checkout's SQL on the next Hub
    # restart, so only a run that applies those migrations itself pins it. The
    # pinned migrate-database finds nothing to do on a database that is ahead.
    if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
      PINNED="${PINNED} migrate-database"
      cat <<EOF
  migrate-database:
    image: ${API_IMAGE}
EOF
    fi
  fi
  cat <<EOF
  gateway:
    image: ${GATEWAY_IMAGE}
${ENV_FILE_YAML}
EOF
  if keep_swapped hbpe-service "$HBPE_IMAGE"; then
    PINNED="${PINNED} hbpe-service"
    cat <<EOF
  hbpe-service:
    image: ${HBPE_IMAGE}
    extra_hosts:
      - host.docker.internal:host-gateway
${ENV_FILE_YAML}
EOF
  fi
  if keep_swapped summary-service "$SUMMARY_IMAGE"; then
    PINNED="${PINNED} summary-service"
    cat <<EOF
  summary-service:
    image: ${SUMMARY_IMAGE}
${ENV_FILE_YAML}
EOF
  fi
  cat <<EOF
  database:
    shm_size: 1gb
EOF
} > "$OVERRIDE_TMP"
chmod 644 "$OVERRIDE_TMP"

if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  echo "==> Running migrate-database (applies pending SQL migrations)..."
  hub_compose "run --rm migrate-database" "$OVERRIDE_TMP"
fi

echo "==> Recreating ${RECREATE} with PR images..."
hub_compose "up -d --force-recreate --no-deps ${RECREATE}" "$OVERRIDE_TMP"

check_backup_slot
if [[ -f "$USER_COMPOSE_HOST" ]] && ! is_pr_test_override "$USER_COMPOSE_HOST"; then
  mv "$USER_COMPOSE_HOST" "$USER_COMPOSE_BACKUP_HOST"
  echo "==> Moved the existing user compose override aside: $USER_COMPOSE_BACKUP_HOST"
  echo "    Its settings are not applied while the swap is in place. hub-pr-test-rollback.sh puts it back."
fi

mv "$OVERRIDE_TMP" "$USER_COMPOSE_HOST"
OVERRIDE_TMP=""
echo "==> Wrote override: $USER_COMPOSE_HOST (pins ${PINNED} to ${PR_TAG})"

if [[ -f "$LEGACY_OVERRIDE_HOST" ]]; then
  rm -f "$LEGACY_OVERRIDE_HOST"
  echo "==> Removed the old override the Hub never read: $LEGACY_OVERRIDE_HOST"
fi

refresh_traefik_upstream

echo ""
echo "==> Deploy complete."
echo "    docker ps --filter name=${COMPOSE_PROJECT} --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'"
echo "    docker logs ${COMPOSE_PROJECT}-api-1 --tail 40"
echo ""
echo "Rollback: ${REPO_ROOT}/scripts/dev/hub-pr-test-rollback.sh"
