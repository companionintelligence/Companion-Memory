# shellcheck shell=bash
# ── Image Map ──────────────────────────────────────────────────────────
# Maps: local-image-name → registry-repo-name
#
# Local images are built by `make build ENV=production` as ci/<name>.
# Registry repos use companion/<name> as the public namespace.
# Parallel arrays instead of associative array (bash 3.2 compat).
#
# Shared by publish.sh (tag + push) and merge-manifests.sh (multi-arch
# manifest list creation) so the two can never disagree on the image set.

# shellcheck disable=SC2034  # consumed by the sourcing scripts

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
