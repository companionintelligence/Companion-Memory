#!/usr/bin/env bash
# Roll back hub-pr-test-deploy.sh to Hub-pinned production images.
# See docs/runbooks/one-off-prod-data-testing.md
set -euo pipefail

# shellcheck source=hub-pr-test-common.sh
source "$(dirname "$0")/hub-pr-test-common.sh"

require_app_env

if is_pr_test_override "$USER_COMPOSE_HOST"; then
  rm -f "$USER_COMPOSE_HOST"
  echo "==> Removed override: $USER_COMPOSE_HOST"

  if [[ -f "$USER_COMPOSE_BACKUP_HOST" ]]; then
    mv "$USER_COMPOSE_BACKUP_HOST" "$USER_COMPOSE_HOST"
    echo "==> Put back the user compose override it replaced: $USER_COMPOSE_HOST"
    echo "    The Hub applies it again from now on."
  fi
elif [[ -f "$USER_COMPOSE_HOST" ]]; then
  echo "==> Left $USER_COMPOSE_HOST in place: hub-pr-test-deploy.sh did not write it."
  echo "    The Hub keeps applying it. If it pins test images, delete it and rerun this script."
fi

if [[ -f "$LEGACY_OVERRIDE_HOST" ]]; then
  rm -f "$LEGACY_OVERRIDE_HOST"
  echo "==> Removed override: $LEGACY_OVERRIDE_HOST"
fi

echo "==> Recreating api + gateway + hbpe-service + summary-service from Hub-pinned compose..."
hub_compose "up -d --force-recreate --no-deps api gateway hbpe-service summary-service"

refresh_traefik_upstream

echo "==> Rollback complete."
