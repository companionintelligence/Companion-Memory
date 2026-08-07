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
# Companion Memory needs TWO real departures, and they are the only two:
#
#   1  capture runs FIVE times, under three different identities, because
#      `ci-video capture` shares one browser context per viewport and cannot be
#      signed in and signed out at once. See the capture section below.
#   2  video-kit is installed from the private GitHub Packages registry, not
#      resolved from a CI-Common checkout on disk. So the generic file's
#      `── which kit answered ──` staleness guard does not apply here — there is
#      no working tree to be stale — and this file carries the registry-shaped
#      equivalent instead: an exact pin, a resolution check, and the same
#      announcement. Do NOT reconcile that block against the generic one.
#
# Port any other change to this file from the generic one.
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

# ── which kit answered ───────────────────────────────────────────────────────
# The install above pulls @companionintelligence/video-kit from the private
# GitHub Packages registry, so this repo has no CI-Common working tree that
# could be stale. That is why the fleet's stale-kit guard — CI-Common #56, the
# `── which kit answered ──` block in the generic template/make.sh — was
# deliberately not ported here: it has nothing to check.
#
# The registry-shaped hazard is the same one wearing different clothes. A
# floating range means `npm install` resolves whatever the registry's newest
# matching version is AT THE TIME OF THE RUN, and nothing here ever said which
# one it got. The kit decides pacing, camera and composition, so a version
# picked up on its own re-renders the cut and moves the shots — and this repo
# COMMITS its shots and already carries two documented drift shots (the
# activity-timeline rail and the force-graph layout). A silent kit change
# arrives in review looking exactly like a real UI diff, which is the most
# expensive way there is to discover it.
#
# Not hypothetical, and narrower than it first looks — the specifics matter
# because they say what this guard can and cannot save you from:
#
#   * The old spec was `^0.7.0`. On a 0.x version npm's caret pins the MINOR,
#     so that range is `>=0.7.0 <0.8.0` — it floats across patches only. It
#     silently moved 0.7.0 -> 0.7.2 when those published on 2026-08-07, one of
#     which was a PACING change (CI-Common #44). It could never have reached
#     0.9.1 or 0.10.0, and no range starting `^0.7` ever will.
#   * The registry carries 0.1.1, 0.1.2 and 0.7.2 — nothing else. Publishing is
#     driven by a `video-kit-v*` tag, and 0.8.0 through 0.10.0 were released in
#     CI-Common's package.json but never tagged, so they do not exist to install.
#
# So this half of the pipeline is on the 0.7.x line while the eight repos that
# resolve the kit off disk are on 0.10.0. Announcing the version is what makes
# that visible; closing it means publishing a tag and re-shooting deliberately,
# which is its own commit and not this one's business.
#
# Pin exactly, verify what resolved, announce it every run. The label uses the
# same shape and vocabulary as `kitLabel` in CI-Engineering tools/lib/workspace.mjs
# and the generic make.sh, so both halves of the pipeline report identically and
# one grep for `^kit:` finds either.
KIT_NAME="@companionintelligence/video-kit"
KIT_SPEC="$(node -p "require('./package.json').devDependencies['$KIT_NAME']" 2>/dev/null || echo '')"
[ -n "$KIT_SPEC" ] && [ "$KIT_SPEC" != "undefined" ] \
  || die "video/package.json declares no $KIT_NAME devDependency — the kit cannot be pinned"

# The resolved version and the path it came from. The path is what makes a
# mismatch diagnosable: node resolution walks UP from video/, so a hoisted copy
# at the repo root can win over video/node_modules. ("./package.json" is in the
# kit's exports map, so this resolves rather than throwing ERR_PACKAGE_PATH_NOT_EXPORTED.)
KIT_HAVE="$(node -p "require('$KIT_NAME/package.json').version" 2>/dev/null || true)"
KIT_FROM="$(node -p "require.resolve('$KIT_NAME/package.json')" 2>/dev/null || true)"
[ -n "$KIT_HAVE" ] \
  || die "$KIT_NAME does not resolve from $VIDEO_DIR after 'npm install' — capture cannot run"

# An exact pin is the only spec a string comparison can actually verify. A range
# is handled deliberately rather than silently: it cannot promise the next run
# resolves the same build.
case "$KIT_SPEC" in
  [0-9]*) KIT_PIN="$KIT_SPEC" ;;
  *)      KIT_PIN="" ;;
esac

if [ -n "$KIT_PIN" ] && [ "$KIT_HAVE" != "$KIT_PIN" ]; then
  die "video-kit version mismatch — refusing to capture.
     video/package.json pins : $KIT_PIN
     actually resolved       : $KIT_HAVE
     resolved from           : $KIT_FROM
     A shot set is byte-stable only within one kit; building from $KIT_HAVE
     would re-render the cut and rewrite committed shots that reviewers read as
     a real UI change. Clear video/node_modules and re-run, or reconcile the pin."
fi

if [ -n "$KIT_PIN" ]; then
  printf '\033[0;2mkit:\033[0m \033[0;32m%s\033[0m\n' \
    "video-kit $KIT_HAVE — GitHub Packages registry: pinned $KIT_PIN"
else
  warn "kit: video-kit $KIT_HAVE — GitHub Packages registry: spec '$KIT_SPEC' is a range, not an exact pin.
     Resolved $KIT_HAVE for this run, but a later run may resolve a different
     build and re-render every scene. Pin an exact version, then re-shoot
     deliberately in the same commit."
fi

# Unlike the generic make.sh, this repo installs Playwright as part of the
# toolchain above: video/package.json pins it exactly and `npm install` here
# honours that pin, so there is no separate pinned-install step to run.
#
# What is still missing is the CHECK. Node resolution walks UP from video/, and
# this repo's root devDependencies carry @playwright/test ^1.57.0 — a range that
# resolves to whatever the root happens to hoist. video/node_modules normally
# wins, but nothing here has ever verified that it did. A half-finished install,
# a stale tree, or a future workspace/hoisting change would silently hand
# capture the root's Playwright instead.
#
# That is not cosmetic. Capture is byte-stable only within one resolved
# Playwright build; shooting on the wrong one rewrites every committed shot by a
# fraction of a percent of pixels — pure text antialiasing — and arrives in
# review looking like a real UI change. This repo commits its shots and already
# has two documented drift shots, so a silent version change is most expensive
# here of anywhere in the fleet. Verify, and refuse to shoot on a mismatch.
PW_SPEC="$(node -p "require('./package.json').devDependencies.playwright" 2>/dev/null || echo '')"
[ -n "$PW_SPEC" ] && [ "$PW_SPEC" != "undefined" ] \
  || die "video/package.json declares no playwright devDependency — capture cannot be pinned"

# The resolved version, and the path it came from. The path is what makes a
# mismatch diagnosable: "1.60.0, from the repo root" rather than a bare "1.60.0".
PW_HAVE="$(node -p "require('playwright/package.json').version" 2>/dev/null || true)"
PW_FROM="$(node -p "require.resolve('playwright/package.json')" 2>/dev/null || true)"
[ -n "$PW_HAVE" ] \
  || die "playwright does not resolve from $VIDEO_DIR after 'npm install' — capture cannot run"

# An exact pin is the only spec a string comparison can actually verify, and it
# is what this repo uses. A range is handled deliberately rather than silently:
# it cannot promise the next shoot resolves the same build.
case "$PW_SPEC" in
  [0-9]*) PW_PIN="$PW_SPEC" ;;
  *)      PW_PIN="" ;;
esac

if [ -n "$PW_PIN" ] && [ "$PW_HAVE" != "$PW_PIN" ]; then
  die "Playwright version mismatch — refusing to capture.
     video/package.json pins : $PW_PIN
     actually resolved       : $PW_HAVE
     resolved from           : $PW_FROM
     Capture is only byte-stable within one build; shooting on $PW_HAVE would
     rewrite every committed shot with antialiasing noise that reads as a real
     UI diff. Remove that copy or reconcile the pin, then re-run."
fi
if [ -z "$PW_PIN" ]; then
  warn "video/package.json declares playwright '$PW_SPEC' — a range, not an exact pin.
     Resolved $PW_HAVE for this run, but a later shoot may resolve a different
     build and rewrite every shot. Pin an exact version for byte-stable capture."
fi
if [ -n "$PW_PIN" ]; then
  say "Playwright $PW_HAVE (matches the pin), from $PW_FROM"
else
  say "Playwright $PW_HAVE (spec '$PW_SPEC', unpinned), from $PW_FROM"
fi

say "installing Chromium for Playwright"
# Idempotent and cached under ~/Library/Caches/ms-playwright, so a no-op after
# the first run. No --with-deps: that is an apt path and does nothing on macOS.
#
# Driven through the Playwright resolved just above, NOT `npx playwright`. npx
# walks up the same way node does and resolves a BINARY, which is a different
# lookup from the `require('playwright')` the kit's capture.mjs performs — so it
# can install the browser build for the root's Playwright rather than the pinned
# one. The browser must match the Playwright that will actually drive it.
# `playwright/cli.js` is not in the package's exports map, so the path is derived
# from the package.json that resolution above already located.
PW_DIR="$(node -p "require('path').dirname(require.resolve('playwright/package.json'))")"
node "$PW_DIR/cli.js" install chromium

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
# memory-map-view is absent from pass 1 on purpose, and STILL IS. Its committed
# shots were taken against the real-corpus stage (video/README.md, "The
# real-corpus stage"); the stock seed writes no ci.events.location_coordinates,
# so the shot's content-gated waitFor would time out and take the other nine
# shots in this pass down with it. Re-shoot it from the real-corpus stage, or
# fix seed-events.ts first — hazard 13 in capture.config.mjs has the diff.
#
# ⚠️ THIS LIST IS NOT VALIDATED AGAINST THE STORYBOARD, so keeping it in step is
# manual and a drift here is SILENT IN BOTH DIRECTIONS. `ci-video capture`
# implements --only as `shots.filter((s) => only.includes(s.id))`
# (video-kit src/capture.mjs:176) — a plain filter, not a lookup. An id named
# here that no longer exists in storyboard.json matches nothing and is skipped
# without a word; a shot added to storyboard.json but not named here is simply
# never requested, and the only thing that catches it is `ci-video check`
# failing on the slate several steps later.
#
# That is exactly what happened between #1871 and this commit: #1871 replaced
# the /people scene with /stats, and this list kept `people-directory` (gone
# from the storyboard) while never gaining `memory-stats` (added to it). So
# pass 1 silently captured eight shots instead of nine and memory-stats was
# unreachable through make.sh at all — which is why both of its viewports were
# still missing after a "successful" capture run.
AUTHED_SHOTS=feed-overview,memory-list-view,memory-detail-sheet,memory-search-results,memory-graph-view,memory-stats,insights-list,insight-detail-view,connect-providers

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
# No --allow-slates any more: all 30 shots exist, so the missing-shot gate is
# live again. That gate is the only thing standing between this repo and a
# narrated slideshow of placeholders shipping as a product video — if it starts
# failing, capture the shot or cut the scene. Do not re-add the flag.
npm run check

if [ "$RENDER" = 1 ]; then
  say "rendering"
  npm run render
  say "done"
  ls -lh out/*.mp4 2>/dev/null || warn "no mp4 found in video/out/"
else
  say "done — capture only (--no-render); screenshots in video/assets/shots/"
fi
