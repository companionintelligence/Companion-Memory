# shellcheck shell=bash
#
# Companion Memory's capture stage: the whole appliance, not a static front end.
#
# Defines stage_up / stage_down for video/make.sh. Ported from
# .github/workflows/e2e.yml, which is the authoritative recipe, plus the parts
# that only bite on a developer's machine (colima, an exact Node, and three
# sibling agents holding ports).
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
