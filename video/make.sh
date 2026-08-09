#!/usr/bin/env bash
#
# Build the product video ON THIS MACHINE. No GitHub Actions, nothing uploaded.
#
#   ./video/make.sh                 stage the app, capture, check, render
#   ./video/make.sh --no-render     capture and check only (much faster)
#   ./video/make.sh --only <id>     re-shoot a single shot by id
#   ./video/make.sh --keep-up       leave the stage running when it finishes
#
# The rendered cut lands in video/out/, which is gitignored — a video is a build
# artifact, rendered on demand. The screenshots land in video/assets/shots/ and
# ARE committed: without them a checkout cannot render at all. Re-capture and
# commit them whenever you change a screen the video covers.
#
# THIS FILE IS GENERIC — it is the same in every product repo. Everything
# repo-specific lives in video/stage.sh, which defines stage_up and stage_down.
#
# THE CANONICAL COPY is @companionintelligence/video-kit's template/make.sh, and
# every repo's video/make.sh is a byte-identical copy of it. Fix bugs in the kit
# and roll the change out; editing a repo copy is how the copies drift — which is
# how six repos ended up running five different runners, four of them with a
# Playwright guard that checked the wrong thing, and how the stale-kit guard
# below came to live in seven repo copies for a day before it existed in the kit
# at all. To see what a repo has diverged by, from the repo root:
#
#   diff video/make.sh <CI-Common>/packages/video-kit/template/make.sh
#
# A healthy repo prints nothing. This paragraph is worded to be true read from
# either place, because it is the same bytes in both.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$PWD"
VIDEO_DIR="$REPO_ROOT/video"

RENDER=1
KEEP_UP=0
ONLY=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-render) RENDER=0; shift ;;
    --keep-up)   KEEP_UP=1; shift ;;
    --only)      ONLY+=(--only "$2"); shift 2 ;;
    -h|--help)   sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m ! %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[1;31m x %s\033[0m\n' "$*" >&2; exit 1; }

# ── ports ────────────────────────────────────────────────────────────────────
# A developer's machine is not a fresh CI runner: Docker, tunnels and other
# projects are already holding ports. "Is something answering HTTP 200 here?" is
# the wrong question — the first thing tried, :8080, was held by Docker and
# answered nothing, so the check passed and the server then died on EADDRINUSE.
# Ask whether the port is BOUND.
port_is_free() {
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# Return the preferred port if free, else the next free one above it. Stages
# export their own base-URL variable from this, so a busy port relocates the
# stage instead of failing the run.
pick_port() {
  local want="$1" p="$1"
  for _ in $(seq 1 50); do
    port_is_free "$p" && { echo "$p"; return 0; }
    p=$((p + 1))
  done
  die "no free port found near $want"
}

# ── prerequisites ────────────────────────────────────────────────────────────
# Checked up front, with the fix in the message. Discovering that ffmpeg is
# missing after a four-minute capture wastes four minutes.
command -v node >/dev/null || die "node not found"
command -v npm  >/dev/null || die "npm not found"
if [ "$RENDER" = 1 ]; then
  command -v ffmpeg  >/dev/null || die "ffmpeg not found — 'brew install ffmpeg', or use --no-render"
  command -v ffprobe >/dev/null || die "ffprobe not found — 'brew install ffmpeg', or use --no-render"
fi

# video-kit comes off the CI-Common checkout on disk, NOT the package registry.
# The package is private, so a registry install needs a token; running the kit's
# bin directly removes authentication from the local path entirely. Same
# resolution CI-Engineering's tools/make-videos.mjs uses, so both runners agree
# on which kit is in play.
KIT_REL="CI-Common/packages/video-kit/bin/ci-video.mjs"
KIT=""
if [ -n "${CI_WORKSPACE:-}" ]; then
  KIT="$CI_WORKSPACE/$KIT_REL"
else
  # Walk UP looking for the workspace, rather than assuming it is the parent
  # directory. This checkout may be a git worktree (../ is .worktrees/) or a
  # nested clone, and in both cases the sibling-directory guess is wrong.
  d="$REPO_ROOT"
  while [ "$d" != "/" ]; do
    if [ -f "$d/$KIT_REL" ]; then KIT="$d/$KIT_REL"; break; fi
    d="$(dirname "$d")"
  done
fi
[ -n "$KIT" ] && [ -f "$KIT" ] || die "video-kit not found (looked for */$KIT_REL above $REPO_ROOT)
     Clone CI-Common into the workspace, or set CI_WORKSPACE to the directory holding it."

# ── which kit answered ───────────────────────────────────────────────────────
# That resolution above lands on a WORKING TREE, and a working tree is whatever
# branch someone left it on. CI-Engineering's tools pinned their half of this
# (they export the kit from origin/<default> and print which one answered); this
# half was never pinned, so `bash video/make.sh` silently captured and built with
# whatever the shared CI-Common clone happened to be checked out at.
#
# Not hypothetical. On 2026-08-05 that clone sat at video-kit 0.1.2 while
# origin/main carried 0.2.0 with a repainted brand: six products were re-rendered
# specifically to pick the repaint up and came out byte-identical. It was still
# open on 2026-08-06, by then 0.1.2 against 0.7.0. A stale kit is invisible by
# nature — the run reports success either way — so the only thing that makes it
# visible is printing it, and the only thing that stops it is refusing.
#
# Announce always; refuse when the tree is behind origin or dirty. Same shape and
# vocabulary as `kitLabel` in CI-Engineering tools/lib/workspace.mjs, so the two
# halves of the pipeline report identically.
KIT_ROOT="${KIT%/bin/ci-video.mjs}"
KIT_REPO_DIR="${KIT%/packages/video-kit/bin/ci-video.mjs}"
KIT_VERSION="$(node -p "require('$KIT_ROOT/package.json').version" 2>/dev/null || echo unknown)"

kit_git() { git -C "$KIT_REPO_DIR" "$@" 2>/dev/null; }

KIT_NOTES=()
KIT_STALE=0

if kit_git rev-parse --git-dir >/dev/null; then
  # Always fetch before asserting branch state: a stale origin ref reports a
  # current tree as behind, or worse, a behind tree as current.
  kit_git fetch --quiet origin || warn "could not fetch CI-Common — the comparison below may itself be stale"

  KIT_DEFAULT="$(kit_git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')"
  [ -n "$KIT_DEFAULT" ] || KIT_DEFAULT=main
  KIT_BRANCH="$(kit_git symbolic-ref --short HEAD || echo "")"
  if [ -n "$KIT_BRANCH" ]; then
    KIT_WHERE="on $KIT_BRANCH"
  else
    KIT_BRANCH="$(kit_git rev-parse --short HEAD || echo unknown)"
    KIT_WHERE="detached at $KIT_BRANCH"
  fi

  [ "$KIT_BRANCH" = "$KIT_DEFAULT" ] || KIT_WHERE="$KIT_WHERE, not $KIT_DEFAULT"
  KIT_NOTES+=("$KIT_WHERE")

  # Behind-ness is measured over packages/video-kit only. CI-Common carries far
  # more than the kit, and blocking a capture because an unrelated package moved
  # would train everyone to set the override permanently.
  KIT_BEHIND="$(kit_git rev-list --count "HEAD..origin/$KIT_DEFAULT" -- packages/video-kit || echo 0)"
  if [ "${KIT_BEHIND:-0}" -gt 0 ]; then
    KIT_NOTES+=("$KIT_BEHIND commit(s) behind origin/$KIT_DEFAULT under packages/video-kit")
    KIT_STALE=1
  fi

  if [ -n "$(kit_git status --porcelain -- packages/video-kit)" ]; then
    KIT_NOTES+=("uncommitted changes under packages/video-kit")
    KIT_STALE=1
  fi
else
  KIT_NOTES+=("not a git checkout — provenance unknown")
  KIT_STALE=1
fi

# Joined by hand: "${arr[*]}" separates on the FIRST character of IFS only, so
# IFS=', ' silently yields "a,b" rather than "a, b".
KIT_JOINED=""
for note in "${KIT_NOTES[@]}"; do
  [ -z "$KIT_JOINED" ] && KIT_JOINED="$note" || KIT_JOINED="$KIT_JOINED, $note"
done
KIT_LABEL="video-kit $KIT_VERSION — CI-Common working tree: $KIT_JOINED"

if [ "$KIT_STALE" = 0 ]; then
  printf '\033[0;2mkit:\033[0m \033[0;32m%s\033[0m\n' "$KIT_LABEL"
elif [ "${CI_VIDEO_ALLOW_STALE_KIT:-0}" = 1 ]; then
  # The deliberate opt-out, for testing a kit branch. Allowed, never silent.
  warn "kit: $KIT_LABEL"
  warn "proceeding anyway (CI_VIDEO_ALLOW_STALE_KIT=1) — do not commit shots or publish a cut from this run"
else
  die "kit: $KIT_LABEL

     This run would capture and build with a kit that is not what origin ships,
     and would report success either way. Shots are byte-stable only within one
     kit, so committing them from here rewrites the fleet's record for everyone.

     Fix it in a worktree — do NOT switch branches in a shared CI-Common clone,
     other agents are working there:

       git -C $KIT_REPO_DIR worktree add /tmp/video-kit origin/$KIT_DEFAULT
       CI_WORKSPACE=... ./video/make.sh

     Or, if you are deliberately testing a kit branch:

       CI_VIDEO_ALLOW_STALE_KIT=1 ./video/make.sh"
fi

# The one way to invoke the kit. stage.sh uses this too, so a multi-pass
# capture_all cannot accidentally fall back to the npm script — which would go
# looking for the private package in the registry and ask for a token.
kit() { node "$KIT" "$@"; }

# ── the stage ────────────────────────────────────────────────────────────────
# stage.sh is this repo's own staging, ported from the workflow. It must define:
#   stage_up    — start whatever the capture films, and return once it answers
#   stage_down  — stop it (must be safe to call when nothing is running)
# and may set STAGE_LOG to a file worth printing when something fails.
[ -f "$VIDEO_DIR/stage.sh" ] || die "video/stage.sh not found"
# shellcheck source=/dev/null
. "$VIDEO_DIR/stage.sh"

STAGE_LOG="${STAGE_LOG:-$(mktemp -t ci-video-stage)}"
STAGE_STARTED=0

cleanup() {
  local code=$?
  if [ "$STAGE_STARTED" = 1 ] && [ "$KEEP_UP" = 0 ]; then
    say "stopping the stage"
    stage_down || warn "stage_down reported a problem"
  elif [ "$STAGE_STARTED" = 1 ]; then
    warn "leaving the stage running (--keep-up)"
  fi
  if [ $code -ne 0 ] && [ -s "$STAGE_LOG" ]; then
    echo "--- stage log (tail) ---" >&2
    tail -40 "$STAGE_LOG" >&2
  fi
  exit $code
}
trap cleanup EXIT INT TERM

say "starting the stage"
STAGE_STARTED=1
stage_up

# ── capture and render ───────────────────────────────────────────────────────
cd "$VIDEO_DIR"

# Playwright is a PEER dependency on purpose: the kit resolves it from THIS
# project (capture.mjs loadPlaywright uses createRequire against video/), so each
# repo pins the version its own e2e suite uses. It is public, so installing it
# needs no auth.
#
# What matters here is the VERSION, not whether the package is importable. Node
# resolution walks UP from video/, and stage_up has just run `npm ci` at the repo
# root — whose e2e suite pins a DIFFERENT playwright. So `require.resolve` finds
# the ROOT copy and succeeds, and a presence-only check skips the pinned install
# entirely: capture then runs on whatever the root happened to carry.
#
# That is not a cosmetic difference. Capture is only byte-stable within one
# resolved Playwright build. Running a shoot on the wrong one rewrites every
# committed screenshot by a fraction of a percent of pixels — pure text
# antialiasing — which arrives in review looking like a real UI change. Compare
# the versions, and refuse to shoot on a mismatch.
PW_SPEC="$(node -p "require('./package.json').devDependencies.playwright" 2>/dev/null || echo '')"
[ -n "$PW_SPEC" ] && [ "$PW_SPEC" != "undefined" ] \
  || die "video/package.json declares no playwright devDependency — capture cannot be pinned"

# Resolved version, and the path it came from. The path is what makes a mismatch
# diagnosable: "1.60.0, from the repo root" rather than a bare "1.60.0".
pw_version() { node -p "require('playwright/package.json').version" 2>/dev/null || true; }
pw_origin()  { node -p "require.resolve('playwright/package.json')" 2>/dev/null || true; }

# An exact pin is the only spec a string comparison can actually verify, and it
# is what every repo here uses. A range is handled deliberately rather than
# silently: it is not treated as a match, because it cannot promise the next
# shoot resolves the same build. See the warning after the install.
case "$PW_SPEC" in
  [0-9]*) PW_PIN="$PW_SPEC" ;;
  *)      PW_PIN="" ;;
esac

PW_HAVE="$(pw_version)"
if [ -n "$PW_PIN" ] && [ "$PW_HAVE" = "$PW_PIN" ]; then
  say "Playwright $PW_HAVE (matches the pin)"
else
  say "installing Playwright $PW_SPEC (resolved here: ${PW_HAVE:-none})"
  # Installed through a scratch project, NOT `npm install playwright` in here.
  # Even when told to add one package, npm builds the ideal tree from the whole
  # of video/package.json — which lists the private video-kit — so it demands a
  # registry token for a dependency this script deliberately does not use, and
  # exits 1. Under --silent it does that without printing anything at all.
  # A throwaway manifest contains only playwright, and playwright is public.
  _pw_tmp="$(mktemp -d)"
  ( cd "$_pw_tmp" \
      && npm init -y >/dev/null 2>&1 \
      && npm install --silent --no-audit --no-fund "playwright@$PW_SPEC" ) \
    || { rm -rf "$_pw_tmp"; die "could not install playwright@$PW_SPEC"; }

  # Land it in video/node_modules so video/ wins resolution over the repo root —
  # that placement is the whole point, not an implementation detail. Only
  # playwright's own trees are cleared first, so a video/node_modules that
  # legitimately holds anything else survives intact.
  mkdir -p node_modules
  rm -rf node_modules/playwright node_modules/playwright-core
  cp -R "$_pw_tmp/node_modules/." node_modules/
  rm -rf "$_pw_tmp"

  PW_HAVE="$(pw_version)"
  [ -n "$PW_HAVE" ] \
    || die "playwright still does not resolve from $VIDEO_DIR after installing $PW_SPEC"
fi

# Loud, not silent: a wrong-version capture is far more expensive to discover in
# review than a failed run is here.
if [ -n "$PW_PIN" ] && [ "$PW_HAVE" != "$PW_PIN" ]; then
  die "Playwright version mismatch — refusing to capture.
     video/package.json pins : $PW_PIN
     actually resolved       : $PW_HAVE
     resolved from           : $(pw_origin)
     Capture is only byte-stable within one build; shooting on $PW_HAVE would
     rewrite every committed shot with antialiasing noise that reads as a real
     UI diff. Remove that copy or reconcile the pin, then re-run."
fi
if [ -z "$PW_PIN" ]; then
  warn "video/package.json declares playwright '$PW_SPEC' — a range, not an exact pin.
     Resolved $PW_HAVE for this run, but a later shoot may resolve a different
     build and rewrite every shot. Pin an exact version for byte-stable capture."
fi

say "installing Chromium for Playwright"
# Through the kit, which resolves Playwright the way capture does. NOT
# `npx --yes playwright install chromium`, which this file used to run.
#
# The old line was defended here on the grounds that npx "walks up the same way
# node does". It does not. npx resolves a BINARY: it looks for a command called
# `playwright` in node_modules/.bin, walking up — and @playwright/test provides
# that command too, at whatever version the repo root pins for its e2e suite. If
# it finds none it downloads the LATEST Playwright from the registry and runs
# that. The version guard above proves which MODULE resolves; it says nothing
# about which binary answers, so it could not have covered the difference.
#
# Any of those three installs a browser revision belonging to a Playwright that
# is not the one about to shoot, and capture is byte-stable only within one
# build: the wrong one rewrites every committed shot with different text
# antialiasing, which reads in review as a real UI change. `ci-video
# install-browser` derives the CLI from `require.resolve('playwright')` out of
# video/ — the same lookup capture.mjs performs — so the browser and the driver
# are the same installation by construction. It prints both, and says so when a
# differing binary is on the path.
kit install-browser

say "capturing the UI"
# Some repos cannot capture in one pass — a shot may need a different identity,
# a different seeded state, or a stage step in between. Those define capture_all
# in stage.sh and own the whole sequence; everyone else gets the single pass.
# --only always wins, so re-shooting one shot never re-runs a multi-pass script.
if declare -f capture_all >/dev/null && [ ${#ONLY[@]} -eq 0 ]; then
  capture_all
else
  kit capture "${ONLY[@]+"${ONLY[@]}"}"
fi

say "building the compositions"
kit build

say "checking them"
kit check

if [ "$RENDER" = 1 ]; then
  say "rendering"
  kit render
  say "done"
  ls -lh out/*.mp4 2>/dev/null || warn "no mp4 found in video/out/"
else
  say "done — capture only (--no-render); screenshots in video/assets/shots/"
fi
