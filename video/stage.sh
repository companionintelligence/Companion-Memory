# shellcheck shell=bash
#
# Companion Memory's capture stage: the whole appliance, not a static front end.
#
# Defines stage_up / stage_down / capture_all for video/make.sh. Ported from
# .github/workflows/e2e.yml, which is the authoritative recipe, plus the parts
# that only bite on a developer's machine (colima, an exact Node, and three
# sibling agents holding ports).
#
# THIS FILE IS THE ONLY PLACE COMPANION MEMORY DEPARTS FROM THE FLEET.
# video/make.sh is byte-identical to @companionintelligence/video-kit's
# template/make.sh, as it is in every other product repo; everything specific to
# this product lives here. Since video-kit 0.17.0 that template is a 61-line
# SHIM: it finds the kit, exports CI_VIDEO_REPO_ROOT and hands over to the kit's
# own bin/make.sh, so the runner is now a thing to RUN rather than a thing to
# copy. The hooks below are unchanged by that — the shared runner sources this
# file and calls capture_all exactly as the copied runner did.
#
# That was not true until 2026-08-08 — make.sh was a 421-line fork carrying a
# three-pass capture and a registry-shaped kit install — and the two halves of
# the departure were settled separately:
#
#   * the three passes were REAL per-repo variation, so they moved here as
#     capture_all, the hook the template already provides for exactly this;
#   * the registry install was NOT variation, it was a second mechanism. It is
#     gone. The kit now resolves off the CI-Common checkout on disk, the way the
#     other twelve products resolve it, so `video/` needs no token and no
#     .npmrc, and Companion Memory is composed by the same kit that composes
#     every other film. See video/README.md § "Which kit answers, and why it is
#     not installed".
#
# WHAT IT STANDS UP
#   Postgres 18 + TimescaleDB + PostGIS + pgvector   (container, host port $DB_HOST_PORT)
#   188 dbmate migrations + the full seed corpus
#   @ci/be-api                                       (node, :$API_PORT)
#   @ci/fe-web  — Vite, proxies /api -> the API      (node, :$WEB_PORT)
#
# It does NOT start Temporal, MinIO, HBPE or the summary service. e2e.yml does
# not either, and nothing in this storyboard films them.
#
# ⚠️ RUN THIS AGAINST YOUR OWN CHECKOUT. It runs `yarn install` and drops a
# .env, and it stops containers on the way out. Several agents share the clones
# under ~/devel/ci; use `git worktree add` and stage from there.
#
# ⚠️ IT DOES NOT REUSE A RUNNING STACK. COMPOSE_PROJECT_NAME is deliberately
# distinct from the conventional `ci-server` project, and the host ports default
# into the 3191+ band rather than 5432/3030/5173, so staging a capture never
# touches a dev stack someone else is using. stage_down removes only what
# stage_up created — including its volume, so every run re-seeds from scratch
# (the seed rebases every date onto "now"; see hazard 1 in capture.config.mjs).

STAGE_COMPOSE_PROJECT="${STAGE_COMPOSE_PROJECT:-civideo-ci-memory}"

# colima, not Docker Desktop. The `desktop-linux` context is usually the default
# on this machine and is usually dead, so point at colima's socket explicitly
# rather than mutating the user's global docker context.
if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.colima/default/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi

_compose() {
  docker compose -p "$STAGE_COMPOSE_PROJECT" \
    -f "$REPO_ROOT/docker-compose.yml" -f "$REPO_ROOT/docker-compose.local.yml" \
    --profile local "$@"
}

stage_up() {
  # First, and deliberately before docker: this costs about a second and catches
  # a capture plan that cannot shoot the film. It lives here rather than inside
  # capture_all because make.sh calls capture_all only on a full run, and a
  # `--only` run deserves the same check — and because failing after the stage
  # has cost four minutes is the expensive way to learn it.
  _verify_shot_lists

  command -v docker >/dev/null || die "docker not found — colima is the daemon here: 'colima start --cpu 8 --memory 24'"
  docker info >/dev/null 2>&1 || die "docker daemon unreachable — 'colima start --cpu 8 --memory 24'"
  command -v yarn >/dev/null || die "yarn not found — 'corepack enable'"

  # `make health` hard-fails on anything but 22.15.1, and ts-node/@swc under PnP
  # are just as picky. .nvmrc pins it; prepend it if it is installed.
  local want; want="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")"
  if [ "$(node -v)" != "v$want" ]; then
    if [ -x "$HOME/.nvm/versions/node/v$want/bin/node" ]; then
      PATH="$HOME/.nvm/versions/node/v$want/bin:$PATH"; export PATH
    else
      die "node v$want required (.nvmrc), found $(node -v) — 'nvm install $want'"
    fi
  fi

  STAGE_DB_PORT="$(pick_port "${DB_HOST_PORT:-3192}")"
  STAGE_API_PORT="$(pick_port "${API_PORT:-3193}")"
  STAGE_WEB_PORT="$(pick_port "${WEB_PORT:-3191}")"
  export STAGE_DB_PORT STAGE_API_PORT STAGE_WEB_PORT
  # video/capture.config.mjs reads APP_URL.
  export APP_URL="http://localhost:$STAGE_WEB_PORT"

  say "stage: db :$STAGE_DB_PORT · api :$STAGE_API_PORT · web :$STAGE_WEB_PORT"

  # The API reads .env through dotenv (DOTENV_CONFIG_PATH), so the stage's ports
  # have to be written there, not just exported. Later keys win.
  [ -f "$REPO_ROOT/.env" ] || cp "$REPO_ROOT/.env.default" "$REPO_ROOT/.env"
  {
    echo ""
    echo "# --- appended by video/stage.sh (capture stage) ---"
    echo "COMPOSE_PROJECT_NAME=$STAGE_COMPOSE_PROJECT"
    echo "DB_HOST_PORT=$STAGE_DB_PORT"
    echo "DATABASE_PORT=$STAGE_DB_PORT"
    echo "PORT=$STAGE_API_PORT"
    # The fresh-account onboarding passes POST /api/signup, which 400s while
    # signup codes are required (config/default.json ships them ON).
    echo "ENABLE_REQUIRE_SIGNUP_CODES=false"
  } >> "$REPO_ROOT/.env"

  say "installing workspace dependencies (yarn PnP)"
  ( cd "$REPO_ROOT" && YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install ) >> "$STAGE_LOG" 2>&1 \
    || die "yarn install failed — see $STAGE_LOG"

  # The bundled image carries TimescaleDB + PostGIS + pgvector and the role
  # bootstrap; a stock pgvector image lacks all three. Reuse the tag if it is
  # already built — it is ~2 minutes otherwise.
  if ! docker image inspect ci/database:latest >/dev/null 2>&1; then
    say "building the database images"
    ( cd "$REPO_ROOT" && make distribute-license \
      && docker build -f infrastructure/database/Dockerfile       -t ci/database:latest       infrastructure/database \
      && docker build -f infrastructure/setup-database/Dockerfile -t ci/setup-database:latest infrastructure/setup-database ) \
      >> "$STAGE_LOG" 2>&1 || die "database image build failed — see $STAGE_LOG"
  else
    ( cd "$REPO_ROOT" && make distribute-license ) >> "$STAGE_LOG" 2>&1 || true
  fi

  say "starting Postgres"
  ( cd "$REPO_ROOT" && _compose up -d database setup-database ) >> "$STAGE_LOG" 2>&1 \
    || die "compose up failed — see $STAGE_LOG"

  local i
  for i in $(seq 1 60); do
    ( cd "$REPO_ROOT" && _compose exec -T database pg_isready -U postgres -d postgres ) >/dev/null 2>&1 && break
    [ "$i" = 60 ] && die "Postgres never became ready — see $STAGE_LOG"
    sleep 2
  done

  say "running migrations"
  ( cd "$REPO_ROOT" && yarn workspace @ci/be-api migrate ) >> "$STAGE_LOG" 2>&1 \
    || die "migrations failed — see $STAGE_LOG"

  # WITHOUT THIS EVERY SCREEN IN THE STORYBOARD IS AN EMPTY STATE.
  say "seeding (this is what makes the screens worth filming)"
  ( cd "$REPO_ROOT/backend/apps/api" && yarn run exec -- scripts/seed-database/main.ts ) >> "$STAGE_LOG" 2>&1 \
    || die "seed failed — see $STAGE_LOG"

  say "starting the API and the web server"
  ( cd "$REPO_ROOT/backend/apps/api" && yarn dev ) >> "$STAGE_LOG" 2>&1 &
  STAGE_API_PID=$!
  ( cd "$REPO_ROOT/frontend/apps/web" \
    && WEB_PORT="$STAGE_WEB_PORT" API_PROXY_TARGET="http://localhost:$STAGE_API_PORT" yarn dev ) >> "$STAGE_LOG" 2>&1 &
  STAGE_WEB_PID=$!
  export STAGE_API_PID STAGE_WEB_PID

  # Health-check THROUGH Vite, because that is what capture drives. Vite strips
  # the /api prefix, so /api/_internal/features reaches the API's
  # /_internal/features. It is auth-gated: 401 means the whole chain is up.
  # Waiting for HTTP 200 here would wait forever.
  for i in $(seq 1 90); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/_internal/features" 2>/dev/null || true)"
    case "$code" in
      401|200) say "stage is up at $APP_URL"; return 0 ;;
    esac
    kill -0 "$STAGE_API_PID" 2>/dev/null || die "the API exited during startup — see $STAGE_LOG"
    kill -0 "$STAGE_WEB_PID" 2>/dev/null || die "the web server exited during startup — see $STAGE_LOG"
    sleep 2
  done
  die "stage never answered on $APP_URL — see $STAGE_LOG"
}

stage_down() {
  for pid in "${STAGE_WEB_PID:-}" "${STAGE_API_PID:-}"; do
    [ -n "$pid" ] || continue
    # yarn dev spawns vite/nodemon as children; kill the group so nothing is
    # left holding a port.
    kill -- "-$(ps -o pgid= "$pid" 2>/dev/null | tr -d ' ')" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  unset STAGE_API_PID STAGE_WEB_PID

  # -v: the seed rebases every date onto the wall clock at seed time, so a
  # retained volume would silently mix corpora across runs.
  ( cd "$REPO_ROOT" && _compose down -v --remove-orphans ) >/dev/null 2>&1 || true
}

# ── capture: THREE passes, not one ───────────────────────────────────────────
# The template runs `kit capture` once and that is right for the other twelve.
# It is not right here, and the reason is the product rather than taste:
# `ci-video capture` builds ONE browser context per viewport and shares it
# across every shot, so a single run is either signed in or signed out — it
# cannot be both. This storyboard needs two identities:
#
#   1   the seeded, already-onboarded jsmith        (everything behind ProtectedRoute)
#   2-3 a throwaway account, ONE PER SHOT           (onboarding persists progress server-side, so a
#                                                    shared account resumes mid-wizard and renders a
#                                                    "Welcome back" banner over the shot)
#
# It was FIVE passes until the narrative re-cut. That cut dropped the splash and
# login scenes, so the signed-out pass has nothing left to shoot and is gone;
# `/` and `/login` redirect an onboarded user to `/feed`, so were it kept it
# would need `VIDEO_LOGGED_OUT=1` again. It also dropped `onboarding-focus`,
# leaving two fresh-account shots rather than three.
#
# Every pass is explicitly scoped, including the first: `ci-video capture` exits
# 1 on any single failure, so an unscoped run would attempt every shot in the
# storyboard as jsmith, including the two onboarding ones this identity cannot
# reach, and abort before the passes that could have shot them.
#
# ⚠️ THE STORYBOARD NO LONGER REFERENCES EIGHT OF THE COMMITTED SHOTS —
# splash-screen, login-form, onboarding-focus, feed-overview, memory-map-view,
# memory-stats, insight-detail-view and connect-providers. Their PNGs are kept
# (video/README.md § "What is committed": the shot library is an input anyone
# can render from, and `memory-map-view` cost a 826,478-item real-corpus load),
# but NOTHING BELOW SHOOTS THEM ANY MORE, because `ci-video capture` can only
# shoot ids the storyboard declares. They are frozen at whatever the product
# looked like when they were taken. `memory-map-view` is already stale against
# CI-Server #1891, which restored the Esri attribution control to `Map.tsx`
# after that shot was captured — re-shoot it from `video/stage.real-corpus.sh`
# in the same commit as any scene that brings the map back.
AUTHED_SHOTS=memory-list-view,memory-detail-sheet,memory-search-results,memory-graph-view,insights-list
FRESH_SHOTS="onboarding-connect onboarding-trust"

# ── shots that are not captures ──────────────────────────────────────────────
# Two scenes in this film are Companion Intelligence's OWN ARTWORK from
# ci.computer/memory rather than pictures of the product: the collect-digital-
# traces graphic and the architecture explainer out of the 2026 Q3 short deck.
# `shotPath` — assets/shots/<id>.png — is the only full-frame image slot the
# scene grammar has, so they live there, and the storyboard declares them as
# shots. They are NOT capturable: there is no URL to point Playwright at and no
# product state to reach, and asking capture for them would fail the pass.
#
# So they are subtracted from the check below rather than being an exception to
# it. Naming them here is the point: without this list they would look exactly
# like a shot somebody forgot to add to a pass, which is the failure the check
# exists to catch. Re-generate them from video/README.md § "The two graphic
# plates" if the artwork on the site changes; they are composited at each
# viewport's native plate size, so they must never be produced by hand-scaling.
GRAPHIC_SHOTS="graphic-traces graphic-architecture"

# Does the capture plan above still match the film?
#
# Both directions, and both are fatal. An id named above that the storyboard
# dropped would be silently skipped; a shot the storyboard declares that no pass
# names is never requested at all and only surfaces as a missing-shot failure in
# `check`, several minutes and one stage later.
#
# The lists used to carry a warning that they were NOT validated against the
# storyboard and that drift was silent in both directions — which is exactly how
# #1871 left `people-directory` (deleted from the storyboard) in them while never
# adding `memory-stats` (added to it), so a "successful" run captured eight
# shots instead of nine. That warning is this function. `ci-video capture`
# implements --only as `shots.filter((s) => only.includes(s.id))` (video-kit
# src/capture.mjs) — a plain filter, not a lookup — so an id named here that the
# storyboard does not declare matches nothing and is skipped without a word.
#
# Paths are absolute: stage_up runs from REPO_ROOT, capture_all from $VIDEO_DIR.
_verify_shot_lists() {
  local requested declared orphaned unshot g
  requested="$( { echo "$AUTHED_SHOTS" | tr ',' '\n'; echo "$FRESH_SHOTS" | tr ' ' '\n'; } | sed '/^$/d' | sort -u)"
  declared="$(node -p "
    const sb = require('$VIDEO_DIR/storyboard.json');
    const graphics = new Set('$GRAPHIC_SHOTS'.split(/\s+/).filter(Boolean));
    [...new Set(sb.scenes.flatMap((s) => (s.shots ?? []).map((h) => h.id)))]
      .filter((id) => !graphics.has(id))
      .sort()
      .join('\n');
  ")"

  # A graphic named above that the storyboard no longer uses is its own kind of
  # rot — the plate stays committed and nothing points at it — so say so too.
  for g in $GRAPHIC_SHOTS; do
    node -p "require('$VIDEO_DIR/storyboard.json').scenes.some((s) => (s.shots ?? []).some((h) => h.id === '$g'))" \
      | grep -q true || die "GRAPHIC_SHOTS names '$g', but no scene in storyboard.json uses it.
     Either drop it from that list or drop assets/shots/$g{,.mobile}.png with it."
  done

  orphaned="$(comm -23 <(echo "$requested") <(echo "$declared"))"
  unshot="$(comm -13 <(echo "$requested") <(echo "$declared"))"
  [ -z "$orphaned" ] || die "these ids are named in video/stage.sh but not declared in storyboard.json —
     capture would skip them silently:
$(echo "$orphaned" | sed 's/^/       /')"
  [ -z "$unshot" ] || die "these shots are declared in storyboard.json but named in no capture pass —
     they would never be requested, and \`check\` would fail on the slate:
$(echo "$unshot" | sed 's/^/       /')"
}

# make.sh calls this instead of its single `kit capture` when no --only is given;
# --only always wins, so re-shooting one shot never re-runs the whole sequence.
# The caller owns the identity there — pass VIDEO_FRESH_USER=1 in the
# environment when re-shooting an onboarding shot.
#
# `kit` is make.sh's one way to invoke the kit (`node "$KIT" "$@"`), and using it
# is what keeps this file honest: the npm scripts in video/package.json would
# look for `ci-video` on PATH, which under the disk-resolution path is not there.
capture_all() {
  local shot n

  say "capturing 1/3 — authenticated (seeded jsmith)"
  kit capture --only "$AUTHED_SHOTS"

  n=1
  for shot in $FRESH_SHOTS; do
    n=$((n + 1))
    say "capturing $n/3 — fresh account for $shot"
    VIDEO_FRESH_USER=1 kit capture --only "$shot"
  done
}
