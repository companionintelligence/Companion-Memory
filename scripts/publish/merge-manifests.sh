#!/usr/bin/env bash
set -euo pipefail

# ── Multi-arch manifest merge ───────────────────────────────────────────
#
# Combines the per-architecture image tags pushed by the publish workflow's
# build matrix (companion/<name>:<version>-amd64 and :<version>-arm64) into
# a single :<version> manifest list, then asserts that every merged tag
# actually resolves for every requested platform.
#
# Usage:
#   VERSION=2026.7.22 ./merge-manifests.sh
#
# Environment:
#   REGISTRY             Docker registry host                    (required)
#   VERSION              Version tag to merge                    (required)
#   ARCHES               Space-separated arch suffixes           (default: "amd64 arm64")
#   REGISTRY_USERNAME    Registry login username                 (required, unless GITHUB_TOKEN is set)
#   REGISTRY_PASSWORD    Registry login password                 (required, unless GITHUB_TOKEN is set)
#   GITHUB_TOKEN         Token used as registry password fallback (e.g. inside GitHub Actions)
#   GITHUB_ACTOR         Username paired with GITHUB_TOKEN        (default: github-actions)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=scripts/publish/images.sh
source "${SCRIPT_DIR}/images.sh"

REGISTRY="${REGISTRY:?REGISTRY is required}"
VERSION="${VERSION:?VERSION is required}"
ARCHES="${ARCHES:-amd64 arm64}"

fail() {
  echo "  ✗ $*" >&2
  exit 1
}

# ── Registry login (same credential fallback as publish.sh) ────────────
if [[ -n "${REGISTRY_USERNAME:-}" && -n "${REGISTRY_PASSWORD:-}" ]]; then
  REG_USER="${REGISTRY_USERNAME}"
  REG_PASS="${REGISTRY_PASSWORD}"
elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
  REG_USER="${GITHUB_ACTOR:-github-actions}"
  REG_PASS="${GITHUB_TOKEN}"
else
  fail "Registry credentials not set: provide REGISTRY_USERNAME and REGISTRY_PASSWORD, or GITHUB_TOKEN"
fi

echo "${REG_PASS}" | docker login "${REGISTRY%%/*}" -u "${REG_USER}" --password-stdin

# ── Merge + verify ──────────────────────────────────────────────────────
echo "Merging manifest lists for ${#IMAGE_REMOTE[@]} image(s) @ ${VERSION} (${ARCHES})"

FAILED=0
for REPO in "${IMAGE_REMOTE[@]}"; do
  TARGET="${REGISTRY}/${REPO}:${VERSION}"

  SOURCES=()
  for ARCH in ${ARCHES}; do
    SOURCES+=("${TARGET}-${ARCH}")
  done

  echo ""
  echo "➤ ${TARGET}"
  if ! docker buildx imagetools create -t "${TARGET}" "${SOURCES[@]}"; then
    echo "  ✗ manifest create failed" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  # Post-publish assertion: the merged tag must resolve for every platform.
  MANIFEST=$(docker buildx imagetools inspect --raw "${TARGET}")
  for ARCH in ${ARCHES}; do
    if ! echo "${MANIFEST}" | jq -e --arg arch "${ARCH}" \
      '.manifests[]? | select(.platform.os == "linux" and .platform.architecture == $arch)' >/dev/null; then
      echo "  ✗ ${TARGET} does not resolve for linux/${ARCH}" >&2
      FAILED=$((FAILED + 1))
    else
      echo "  ✓ linux/${ARCH}"
    fi
  done
done

echo ""
if [[ ${FAILED} -gt 0 ]]; then
  fail "${FAILED} manifest problem(s) — see log above"
fi
echo "✓ All ${#IMAGE_REMOTE[@]} images publish a manifest list covering: ${ARCHES}"
