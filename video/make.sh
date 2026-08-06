#!/usr/bin/env bash
#
# Build the product video ON THIS MACHINE. No GitHub Actions, nothing uploaded.
#
#   ./video/make.sh                 stage the app, capture, check, render
#   ./video/make.sh --no-render     capture and check only (much faster)
#   ./video/make.sh --only <id>     re-shoot a single shot by id
#   ./video/make.sh --keep-up       leave the stage running when it finishes
#
# video/out/ is gitignored — an MP4 is a build artifact, re-rendered on demand.
# video/assets/shots/ is NOT: the screenshots are committed inputs, so anyone can
# render a cut without standing up the whole appliance. Re-running capture
# therefore EDITS TRACKED FILES; check `git diff --stat video/assets/shots/`
# afterwards, and expect the two documented drift shots (the activity-timeline
# rail and the force-graph layout) to move on any re-seed.
#
# ⚠️ THIS COPY IS NOT THE GENERIC make.sh. Everywhere else in the fleet this file
# is identical across repos and all repo-specific logic lives in video/stage.sh.
# Companion Memory needs one real departure: capture runs FIVE times, under three
# different identities, because `ci-video capture` shares one browser context
# per viewport and cannot be signed in and signed out at once. See the capture
# section below. Port any other change to this file from the generic one.
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

# @companionintelligence/video-kit is a private GitHub Packages package, so the
# install needs a token. Locally that comes from the gh CLI rather than a CI
# secret; video/.npmrc reads it out of NODE_AUTH_TOKEN and nothing is written to
# disk.
if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  command -v gh >/dev/null || die "gh not found — needed for the video-kit token, or export NODE_AUTH_TOKEN yourself"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in — run: gh auth login"
  NODE_AUTH_TOKEN="$(gh auth token)"
  export NODE_AUTH_TOKEN
fi

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

say "installing the video toolchain"
npm install --silent

say "installing Chromium for Playwright"
# Idempotent and cached under ~/Library/Caches/ms-playwright, so a no-op after
# the first run. No --with-deps: that is an apt path and does nothing on macOS.
npx playwright install chromium

# ── capture: FIVE passes, not one ────────────────────────────────────────────
# This is the one place Companion Memory departs from the generic make.sh, and
# it is forced by the product, not by taste. `ci-video capture` builds ONE
# browser context per viewport and shares it across every shot, so a single run
# is either signed in or signed out — it cannot be both. This storyboard needs
# three identities:
#
#   1  the seeded, already-onboarded jsmith          (everything behind ProtectedRoute)
#   2  signed out                                    (/ and /login redirect an onboarded user to /feed)
#   3-5 a throwaway account, ONE PER SHOT            (onboarding persists progress server-side, so a
#                                                     shared account resumes mid-wizard and renders a
#                                                     "Welcome back" banner over the shot)
#
# Every pass is explicitly scoped, including the first: `ci-video capture` exits
# 1 on any single failure, so an unscoped run would attempt all fifteen shots as
# jsmith, five of them structurally unreachable, and abort before passes 2-5.
#
# memory-map-view is absent from pass 1 on purpose — with the stock seed the map
# has nothing on it. See hazard 13 in capture.config.mjs.
AUTHED_SHOTS=feed-overview,memory-list-view,memory-detail-sheet,memory-search-results,memory-graph-view,people-directory,insights-list,insight-detail-view,connect-providers

if [ ${#ONLY[@]} -gt 0 ]; then
  # --only is for re-shooting one shot; the caller owns the identity, so pass
  # VIDEO_LOGGED_OUT=1 / VIDEO_FRESH_USER=1 in the environment if it needs one.
  say "capturing (scoped)"
  npm run capture -- "${ONLY[@]}"
else
  say "capturing 1/5 — authenticated (seeded jsmith)"
  npm run capture -- --only "$AUTHED_SHOTS"

  say "capturing 2/5 — signed out"
  VIDEO_LOGGED_OUT=1 npm run capture -- --only splash-screen,login-form

  for shot in onboarding-focus onboarding-connect onboarding-trust; do
    say "capturing — fresh account for $shot"
    VIDEO_FRESH_USER=1 npm run capture -- --only "$shot"
  done
fi

say "building the compositions"
npm run build

say "checking them"
# --allow-slates: memory-map-view is a known, documented gap (hazard 13), so the
# missing-shot gate would fail every run until the seed is fixed. Drop this flag
# the moment that shot exists — it is the gate that stops a narrated slideshow
# of placeholders shipping as a product video.
npm run check -- --allow-slates

if [ "$RENDER" = 1 ]; then
  say "rendering"
  npm run render
  say "done"
  ls -lh out/*.mp4 2>/dev/null || warn "no mp4 found in video/out/"
else
  say "done — capture only (--no-render); screenshots in video/assets/shots/"
fi
