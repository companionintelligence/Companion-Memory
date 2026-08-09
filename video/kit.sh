#!/usr/bin/env bash
#
# Run one video-kit command against this project.
#
#   ./video/kit.sh status
#   ./video/kit.sh doctor
#   ./video/kit.sh capture --only memory-list-view
#
# WHY THIS FILE EXISTS. Until 2026-08-08 the equivalent was `npm run capture` in
# video/, which worked because video/package.json carried
# `@companionintelligence/video-kit` as a devDependency and video/.npmrc carried
# a GitHub Packages token to install it. That was the fleet's second
# kit-resolution mechanism and it was retired: it could only ever reach 0.7.2,
# the newest version the registry held, so Companion Memory's shots were
# captured by one kit while every other film in the fleet was composed by
# another. video/README.md § "Which kit answers, and why it is not installed"
# has the whole of it.
#
# So the kit is not installed here at all. It is run out of the CI-Common
# checkout on disk — the same resolution `video/make.sh` performs, and the same
# one CI-Engineering's `tools/make-videos.mjs` performs, so all three agree on
# which kit is in play. `make.sh` cannot simply be sourced for this: it is
# byte-identical to the kit's own `template/make.sh` and stages the whole
# appliance on the way through.
#
# ⚠️ THIS IS THE UNGUARDED PATH. `make.sh` refuses to run when the CI-Common
# working tree is behind origin or dirty under packages/video-kit, because a
# stale kit rewrites committed shots while reporting success either way. This
# script only ANNOUNCES what it found — it is for one-off queries
# (`status`, `doctor`) and for `stage.real-corpus.sh`, whose shots are reviewed
# by hand before they are committed anyway. If you are capturing shots you
# intend to commit, go through `./video/make.sh`.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$PWD"

die() { printf '\n\033[1;31m x %s\033[0m\n' "$*" >&2; exit 1; }

# Same lookup as make.sh: honour CI_WORKSPACE, else walk UP rather than assuming
# the parent directory — this checkout may be a git worktree or a nested clone,
# and the sibling-directory guess is wrong in both cases.
KIT_REL="CI-Common/packages/video-kit/bin/ci-video.mjs"
KIT=""
if [ -n "${CI_WORKSPACE:-}" ]; then
  KIT="$CI_WORKSPACE/$KIT_REL"
else
  d="$REPO_ROOT"
  while [ "$d" != "/" ]; do
    if [ -f "$d/$KIT_REL" ]; then KIT="$d/$KIT_REL"; break; fi
    d="$(dirname "$d")"
  done
fi
[ -n "$KIT" ] && [ -f "$KIT" ] || die "video-kit not found (looked for */$KIT_REL above $REPO_ROOT)
     Clone CI-Common into the workspace, or set CI_WORKSPACE to the directory holding it."

# Announced, never silent — which kit answered is the whole point of retiring
# the registry path. Same `^kit:` prefix make.sh and the fleet tools print, so
# one grep finds any of them.
KIT_ROOT="${KIT%/bin/ci-video.mjs}"
KIT_REPO_DIR="${KIT%/packages/video-kit/bin/ci-video.mjs}"
KIT_VERSION="$(node -p "require('$KIT_ROOT/package.json').version" 2>/dev/null || echo unknown)"
KIT_WHERE="$(git -C "$KIT_REPO_DIR" symbolic-ref --short HEAD 2>/dev/null \
  || git -C "$KIT_REPO_DIR" rev-parse --short HEAD 2>/dev/null \
  || echo "not a git checkout")"
[ -z "$(git -C "$KIT_REPO_DIR" status --porcelain -- packages/video-kit 2>/dev/null)" ] \
  || KIT_WHERE="$KIT_WHERE, dirty under packages/video-kit"
printf '\033[0;2mkit:\033[0m video-kit %s — CI-Common working tree: %s (unguarded; make.sh is the guarded path)\n' \
  "$KIT_VERSION" "$KIT_WHERE" >&2

cd "$REPO_ROOT/video"
exec node "$KIT" "$@"
