#!/usr/bin/env bash
#
# gh-packages-auth.sh — get a NODE_AUTH_TOKEN for the @companionintelligence GitHub
# Packages registry (see .yarnrc.yml npmScopes) from your already-authenticated `gh`
# CLI, instead of minting/storing a separate PAT for local installs.
#
# Usage:
#   source scripts/gh-packages-auth.sh     # export NODE_AUTH_TOKEN into this shell
#   scripts/gh-packages-auth.sh --install  # export + run `yarn install` in one step
#
# Requires: gh, already logged in (`gh auth login`).
set -euo pipefail

_die() {
  echo "gh-packages-auth: $1" >&2
  return 1 2>/dev/null || exit 1
}

command -v gh >/dev/null 2>&1 || _die "gh CLI not found — https://cli.github.com/"
gh auth status >/dev/null 2>&1 || _die "not logged in — run 'gh auth login' first"

# Only round-trip through the browser/device flow if we don't already have the scope.
if ! gh auth status 2>&1 | grep -q "read:packages"; then
  echo "gh-packages-auth: requesting read:packages scope..."
  gh auth refresh -s read:packages
fi

export NODE_AUTH_TOKEN
NODE_AUTH_TOKEN="$(gh auth token)"
echo "gh-packages-auth: NODE_AUTH_TOKEN exported for this shell"

if [[ "${1:-}" == "--install" ]]; then
  yarn install
fi
