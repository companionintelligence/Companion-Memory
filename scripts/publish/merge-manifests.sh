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
#   PUSH_LATEST          Also point :latest at this version      (default: false)
#   DIGESTS_DIR          Directory of <arch>.txt files from publish.sh's
#                        DIGEST_FILE ("<remote repo> <sha256 digest>" per line).
#                        When set, each image is merged from those digests, and
#                        a missing or malformed one stops the run before
#                        anything is written. When unset, the per-arch tags
#                        are used as before.
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
PUSH_LATEST="${PUSH_LATEST:-false}"
DIGESTS_DIR="${DIGESTS_DIR:-}"

fail() {
  echo "  ✗ $*" >&2
  exit 1
}

# The digest publish.sh recorded for <repo> on <arch>, or nothing. publish.sh
# appends, so if it ran twice against one file the last line wins.
recorded_digest() {
  local file="${DIGESTS_DIR}/$2.txt"
  [[ -f "${file}" ]] || return 0
  awk -v repo="$1" '$1 == repo { digest = $2 } END { if (digest != "") print digest }' "${file}"
}

# With digests, every image needs one for every arch before anything is
# written, so a leg that pushed nothing cannot leave a half-merged release.
if [[ -n "${DIGESTS_DIR}" ]]; then
  [[ -d "${DIGESTS_DIR}" ]] || fail "DIGESTS_DIR=${DIGESTS_DIR} is not a directory"

  MISSING=0
  for REPO in "${IMAGE_REMOTE[@]}"; do
    for ARCH in ${ARCHES}; do
      if [[ ! "$(recorded_digest "${REPO}" "${ARCH}")" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        echo "  ✗ no recorded linux/${ARCH} digest for ${REPO} in ${DIGESTS_DIR}/${ARCH}.txt" >&2
        MISSING=$((MISSING + 1))
      fi
    done
  done
  [[ ${MISSING} -eq 0 ]] || fail "${MISSING} digest(s) missing, nothing was merged"
fi

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
if [[ "${PUSH_LATEST}" == "true" ]]; then
  echo "PUSH_LATEST=true — :latest will be repointed at ${VERSION}"
fi

FAILED=0
for REPO in "${IMAGE_REMOTE[@]}"; do
  TARGET="${REGISTRY}/${REPO}:${VERSION}"

  echo ""
  echo "➤ ${TARGET}"

  # By digest when the push job recorded them: a tag can be moved by anyone
  # holding a write token between the push and this merge, a digest cannot.
  SOURCES=()
  for ARCH in ${ARCHES}; do
    if [[ -n "${DIGESTS_DIR}" ]]; then
      SOURCES+=("${REGISTRY}/${REPO}@$(recorded_digest "${REPO}" "${ARCH}")")
    else
      SOURCES+=("${TARGET}-${ARCH}")
    fi
  done

  # Alias tags share the version's sources, so one imagetools call writes them
  # all — no extra build, push, or login. Seeded with -t ${TARGET} so the array
  # is never empty: under `set -u`, expanding an empty array is an error on the
  # bash 3.2 this directory targets (see images.sh).
  TAGS=(-t "${TARGET}")
  VERIFY=("${TARGET}")
  if [[ "${PUSH_LATEST}" == "true" ]]; then
    TAGS+=(-t "${REGISTRY}/${REPO}:latest")
    VERIFY+=("${REGISTRY}/${REPO}:latest")
  fi

  if ! docker buildx imagetools create "${TAGS[@]}" "${SOURCES[@]}"; then
    echo "  ✗ manifest create failed" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  # Post-publish assertion: every tag written must resolve for every platform.
  # :latest is checked too — it was a single-arch amd64 manifest for months
  # precisely because nothing asserted against it.
  for TAG in "${VERIFY[@]}"; do
    # Deliberately not `|| fail`: a failed inspect leaves MANIFEST empty, the
    # jq checks below miss, and the tag is counted in FAILED like any other
    # problem. Aborting here instead would skip the remaining images and hide
    # how much is broken.
    #
    # The `|| MANIFEST=''` is what makes that true, and is load-bearing under
    # `set -e`: a bare assignment takes its command substitution's exit status,
    # so a failed inspect would kill the script mid-loop — no ✗ line, no
    # summary, remaining images unchecked. docker's own error still reaches the
    # log because stderr is not captured.
    MANIFEST=$(docker buildx imagetools inspect --raw "${TAG}") || MANIFEST=''
    for ARCH in ${ARCHES}; do
      if ! echo "${MANIFEST}" | jq -e --arg arch "${ARCH}" \
        '.manifests[]? | select(.platform.os == "linux" and .platform.architecture == $arch)' >/dev/null; then
        echo "  ✗ ${TAG} does not resolve for linux/${ARCH}" >&2
        FAILED=$((FAILED + 1))
      else
        echo "  ✓ ${TAG##*:} linux/${ARCH}"
      fi
    done
  done
done

echo ""
if [[ ${FAILED} -gt 0 ]]; then
  # Counted per tag × arch, so this exceeds the image count when more than one
  # tag was written per image.
  fail "${FAILED} manifest problem(s) — see log above"
fi
if [[ "${PUSH_LATEST}" == "true" ]]; then
  echo "✓ All ${#IMAGE_REMOTE[@]} images publish :${VERSION} and :latest as manifest lists covering: ${ARCHES}"
else
  echo "✓ All ${#IMAGE_REMOTE[@]} images publish a manifest list covering: ${ARCHES}"
fi
