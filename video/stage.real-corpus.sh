#!/usr/bin/env bash
#
# The REAL-CORPUS capture stage for Companion Memory.
#
#   ./video/stage.real-corpus.sh up      stand it up, print the URL, exit
#   ./video/stage.real-corpus.sh down    tear it down, volume included
#   ./video/stage.real-corpus.sh shots   up (if needed) + capture the aggregate shots
#
# WHY THIS EXISTS. video/stage.sh seeds a 64-person fixture. That is the right
# stage for fourteen of the fifteen shots in this storyboard and the wrong stage
# for any claim about scale — and it cannot film the map at all, because the seed
# writes no `ci.events.location_coordinates` (hazard 13 in capture.config.mjs).
# This stage loads the owner's real archive — 826,478 items, 23 sources — into a
# throwaway appliance so the map has real places on it.
#
# ⚠️ WHAT MAY BE FILMED AGAINST THIS STAGE: AGGREGATE VIEWS ONLY. No individual
# may be identifiable in any frame. Entity-graph and density visualisations,
# counts, totals, source coverage, settings, and the map at a zoom where no
# street address is legible. NEVER message threads or lists, email bodies,
# contact or people lists, photo grids, purchase history, calendar entries with
# attendee names, filenames carrying personal names, or a map zoomed to a
# residence. If a scene can only be satisfied by one of those, leave it
# uncaptured — the seeded shot is the honest stand-in, because its people are
# fictional. Open every PNG and check it before you commit it.
#
# ⚠️ NOTHING LEAVES THE MACHINE. No geocoding is run: 83 of the 826,478 items
# already carry real WGS84 coordinates and those are what the map plots.
# Forward-geocoding the ~1,400 calendar events that carry a Location string
# would add ~700 pins and would POST those strings to Google. That is the
# owner's call, not this script's.
#
# ⚠️ RUN THIS FROM YOUR OWN WORKTREE. It writes .env, runs `yarn install`, and
# removes its own containers and volume on the way out. Ports live in the 3191+
# band and the compose project is its own, so it can never adopt or tear down a
# stack another agent is running.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$PWD"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m ! %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[1;31m x %s\033[0m\n' "$*" >&2; exit 1; }

# ── knobs ────────────────────────────────────────────────────────────────────
PROJECT="${STAGE_COMPOSE_PROJECT:-civideo-real-memory}"
DB_PORT="${DB_HOST_PORT:-3202}"
API_PORT="${API_PORT:-3203}"
WEB_PORT="${WEB_PORT:-3201}"
IMPORTER_PORT="${IMPORTER_PORT:-12009}"

# The real archive and a checkout of the importer that can push it.
ARCHIVE="${CI_ARCHIVE_DB:-$HOME/devel/liam-test-data-export/ci-sync.db}"
IMPORTER="${CI_IMPORT_TOOLS:-$HOME/devel/ci/CI-Import-Tools}"
WORK="${STAGE_WORK_DIR:-${TMPDIR:-/tmp}/civideo-real-memory}"
STAGE_LOG="${STAGE_LOG:-$WORK/stage.log}"

EMAIL="${AUTH_DEFAULT_USER_EMAIL:-jsmith@example.com}"
PASSWORD="${AUTH_DEFAULT_USER_PASSWORD:-]60.a6{CJ}lB*rHAp;w;}"

# colima, not Docker Desktop — the `desktop-linux` context is usually the
# default here and usually dead. Point at colima's socket rather than mutating
# the user's global docker context.
if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.colima/default/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi

_compose() {
  docker compose -p "$PROJECT" \
    -f "$REPO_ROOT/docker-compose.yml" -f "$REPO_ROOT/docker-compose.local.yml" \
    --profile local "$@"
}

_psql() { docker exec -u postgres "$PROJECT-database-1" psql -U postgres -d companion -Atc "$1"; }

_use_node() {
  local want; want="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")"
  if [ "$(node -v 2>/dev/null || echo none)" != "v$want" ]; then
    [ -x "$HOME/.nvm/versions/node/v$want/bin/node" ] \
      || die "node v$want required (.nvmrc), found $(node -v 2>/dev/null || echo none)"
    PATH="$HOME/.nvm/versions/node/v$want/bin:$PATH"; export PATH
  fi
}

# ── up ───────────────────────────────────────────────────────────────────────
stage_up() {
  command -v docker >/dev/null && docker info >/dev/null 2>&1 \
    || die "docker daemon unreachable — 'colima start --cpu 8 --memory 24'"
  [ -f "$ARCHIVE" ] || die "archive not found at $ARCHIVE — set CI_ARCHIVE_DB"
  [ -d "$IMPORTER/backend" ] || die "CI-Import-Tools not found at $IMPORTER — set CI_IMPORT_TOOLS"
  _use_node
  mkdir -p "$WORK"

  say "installing workspace dependencies (yarn PnP)"
  : "${YARN_CACHE_FOLDER:=$HOME/devel/ci/CI-Server/.yarn/cache}"
  export YARN_CACHE_FOLDER
  ( cd "$REPO_ROOT" && YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install ) >>"$STAGE_LOG" 2>&1 \
    || die "yarn install failed — see $STAGE_LOG"

  [ -f "$REPO_ROOT/.env" ] || cp "$REPO_ROOT/.env.default" "$REPO_ROOT/.env"
  {
    echo ""
    echo "# --- appended by video/stage.real-corpus.sh ---"
    echo "COMPOSE_PROJECT_NAME=$PROJECT"
    echo "DB_HOST_PORT=$DB_PORT"
    echo "DATABASE_PORT=$DB_PORT"
    echo "PORT=$API_PORT"
    echo "ENABLE_REQUIRE_SIGNUP_CODES=false"
  } >> "$REPO_ROOT/.env"

  if ! docker image inspect ci/database:latest >/dev/null 2>&1; then
    say "building the database images"
    ( cd "$REPO_ROOT" && make distribute-license \
      && docker build -f infrastructure/database/Dockerfile       -t ci/database:latest       infrastructure/database \
      && docker build -f infrastructure/setup-database/Dockerfile -t ci/setup-database:latest infrastructure/setup-database ) \
      >>"$STAGE_LOG" 2>&1 || die "database image build failed — see $STAGE_LOG"
  else
    ( cd "$REPO_ROOT" && make distribute-license ) >>"$STAGE_LOG" 2>&1 || true
  fi

  say "starting Postgres on :$DB_PORT"
  ( cd "$REPO_ROOT" && _compose up -d database setup-database ) >>"$STAGE_LOG" 2>&1 \
    || die "compose up failed — see $STAGE_LOG"
  local i
  for i in $(seq 1 60); do
    ( cd "$REPO_ROOT" && _compose exec -T database pg_isready -U postgres -d postgres ) >/dev/null 2>&1 && break
    [ "$i" = 60 ] && die "Postgres never became ready — see $STAGE_LOG"
    sleep 2
  done

  # A stock lock table does not survive this corpus: the July 2026 ingest of the
  # same 826,478 items took CI-Server's Postgres down with "out of shared
  # memory" mid-push. 512 held; 256 held but threw on concurrent ad-hoc queries.
  say "raising max_locks_per_transaction to 512"
  docker exec -u postgres "$PROJECT-database-1" psql -U postgres \
    -c "ALTER SYSTEM SET max_locks_per_transaction = 512;" >>"$STAGE_LOG" 2>&1
  docker restart "$PROJECT-database-1" >>"$STAGE_LOG" 2>&1
  for i in $(seq 1 60); do
    docker exec -u postgres "$PROJECT-database-1" pg_isready -U postgres -d postgres >/dev/null 2>&1 && break
    [ "$i" = 60 ] && die "Postgres did not come back after the restart"
    sleep 2
  done

  say "running migrations"
  ( cd "$REPO_ROOT" && yarn workspace @ci/be-api migrate ) >>"$STAGE_LOG" 2>&1 \
    || die "migrations failed — see $STAGE_LOG"

  # NO SEED. That is the whole point: the corpus below is the fixture.
  say "dropping deferrable indexes for the bulk load"
  ( cd "$REPO_ROOT/backend/apps/api" && yarn run exec -- scripts/bulk-load-indexes.ts drop ) \
    >>"$STAGE_LOG" 2>&1 || warn "index deferral failed — the load will just be slower"

  say "starting the API (:$API_PORT) and the web server (:$WEB_PORT)"
  # tmux, not a background job: `yarn dev` traps SIGINT and inherits the
  # caller's process group, so an agent harness reaping that group tears the
  # whole stage down and it looks like a clean finish.
  command -v tmux >/dev/null || die "tmux not found — 'brew install tmux'"
  tmux -L "$PROJECT" kill-server >/dev/null 2>&1 || true
  tmux -L "$PROJECT" new-session -d -s api \
    "cd '$REPO_ROOT/backend/apps/api' && PATH='$PATH' YARN_CACHE_FOLDER='$YARN_CACHE_FOLDER' yarn dev >>'$WORK/api.log' 2>&1"
  tmux -L "$PROJECT" new-session -d -s web \
    "cd '$REPO_ROOT/frontend/apps/web' && PATH='$PATH' YARN_CACHE_FOLDER='$YARN_CACHE_FOLDER' WEB_PORT=$WEB_PORT API_PROXY_TARGET=http://localhost:$API_PORT yarn dev >>'$WORK/web.log' 2>&1"

  # Health-check THROUGH Vite: /api/_internal/features is auth-gated, so 401 is
  # the success signal. Waiting for 200 waits forever.
  for i in $(seq 1 90); do
    case "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/api/_internal/features" || true)" in
      401|200) break ;;
    esac
    [ "$i" = 90 ] && die "stage never answered on :$WEB_PORT — see $WORK/api.log"
    sleep 2
  done

  say "creating the account and an API key"
  local jar="$WORK/cookies.txt" csrf token apikey
  rm -f "$jar"
  curl -s -c "$jar" "http://localhost:$WEB_PORT/api/authenticate/csrf" -o /dev/null
  csrf="$(awk '/csrfToken/{print $7}' "$jar")"
  curl -s -b "$jar" -c "$jar" -X POST "http://localhost:$WEB_PORT/api/signup" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
    -d "$(printf '{"name":"Companion Owner","email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")" \
    >>"$STAGE_LOG" 2>&1
  # The wizard is not what this stage films, and ProtectedRoute wants an
  # onboarded user, so mark it done directly.
  _psql "UPDATE ci.users SET onboarded = true, onboarded_at = now(), role = 'admin' WHERE email = '$EMAIL';" >/dev/null
  token="$(curl -s -b "$jar" -c "$jar" -X POST "http://localhost:$WEB_PORT/api/authenticate" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
    -d "$(printf '{"username":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).accessToken))')"
  apikey="$(curl -s -b "$jar" -X POST "http://localhost:$WEB_PORT/api/keys" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -H "Authorization: Bearer $token" \
    -d '{"name":"video-corpus-push"}' \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).key))')"
  [ -n "$apikey" ] || die "could not mint an API key — see $STAGE_LOG"
  printf '%s' "$apikey" > "$WORK/apikey"

  # A COPY. The push writes its watermark back into the SQLite `settings` table,
  # and the original is the owner's archive, not a scratch file. Copying also
  # moves MEDIA_STORE_DIR (derived from dirname(dbPath)) away from the real
  # media tree, so no photo bytes are uploaded — which is what we want: a
  # gallery of faces is unfilmable under the aggregate-only rule anyway.
  say "copying the archive to $WORK/corpus.db"
  cp "$ARCHIVE" "$WORK/corpus.db"

  say "starting CI-Import-Tools on :$IMPORTER_PORT (GraphQL lane)"
  # The default `v1` lane is faster and WRONG for this job: captureEventSchema
  # has no location field, so the importer folds locationCoordinates into
  # `payload` and BulkIngestController never lifts it back into
  # ci.events.location_coordinates — the map would be empty. The GraphQL lane
  # writes the typed columns. 4/1000 rather than 8/5000: the importer was
  # OOM-killed twice at the higher settings.
  tmux -L "$PROJECT" new-session -d -s importer \
    "cd '$IMPORTER/backend' && PATH='$PATH' \
     CI_OIDC_DISABLE=1 CI_ALLOW_UNAUTHENTICATED=1 CI_ADMIN_ADDR=127.0.0.1:$IMPORTER_PORT \
     CI_DB_PATH='$WORK/corpus.db' CI_SERVER_URL=http://localhost:$API_PORT \
     CI_SERVER_TOKEN='$apikey' CI_PUSH_TRANSPORT=graphql CI_PUSH_BATCH_SIZE=1000 \
     CI_PUSH_CONCURRENCY=4 NODE_OPTIONS=--max-old-space-size=12288 \
     node node_modules/.bin/tsx src/server.ts >>'$WORK/importer.log' 2>&1"
  for i in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$IMPORTER_PORT/api/stats" || true)" = 200 ] && break
    [ "$i" = 60 ] && die "importer never answered on :$IMPORTER_PORT — see $WORK/importer.log"
    sleep 2
  done

  # `"full": true` IS LOAD-BEARING. The watermark in the SQLite `settings` table
  # is server-agnostic — it does not record WHICH appliance it pushed to — so an
  # incremental push to a brand-new one silently skips the 640,000 items at or
  # before it and you film a fifth of the corpus without any error.
  say "pushing 826,478 items — this takes ~45 minutes"
  curl -s -X POST "http://127.0.0.1:$IMPORTER_PORT/api/wizard/ci-server/sync" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"url":"http://localhost:%s","apiKey":"%s","full":true,"batchSize":1000,"concurrency":4}' "$API_PORT" "$apikey")" \
    >>"$STAGE_LOG" 2>&1
  _wait_jobs

  # The push moves items only. Entities and relationships are a separate stage,
  # and without them the graph, /people and the stats tiles are all empty.
  # geocode/reverse_geocode are deliberately NOT requested — see the header.
  say "building the entity graph"
  curl -s -X POST "http://127.0.0.1:$IMPORTER_PORT/api/wizard/pipeline/run" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"url":"http://localhost:%s","apiKey":"%s","stages":["sync_graph","extract_people","extract_graph"]}' "$API_PORT" "$apikey")" \
    >>"$STAGE_LOG" 2>&1
  _wait_jobs

  say "recreating the deferred indexes"
  ( cd "$REPO_ROOT/backend/apps/api" && yarn run exec -- scripts/bulk-load-indexes.ts recreate ) \
    >>"$STAGE_LOG" 2>&1 || warn "index recreate failed — see $STAGE_LOG"

  say "loaded:"
  _psql "select 'events '||count(*) from ci.events
         union all select 'communications '||count(*) from ci.communications
         union all select 'content '||count(*) from ci.content
         union all select 'browser_activity '||count(*) from ci.browser_activity
         union all select 'inventory '||count(*) from ci.inventory
         union all select 'entities '||count(*) from ci.entities
         union all select 'events with coordinates '||count(*) from ci.events where location_coordinates is not null;"

  say "stage is up at http://localhost:$WEB_PORT"
}

# The importer's job/run rows are the only progress signal; both legs above are
# async and a long push looks identical to a hung one without this.
_wait_jobs() {
  local i st
  for i in $(seq 1 480); do
    st="$(curl -s "http://127.0.0.1:$IMPORTER_PORT/api/jobs?limit=1" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);const r=Array.isArray(d)?d:(d.jobs||d.items||[]);console.log(r[0]?r[0].status:"none")}catch{console.log("down")}})' 2>/dev/null || echo down)"
    case "$st" in
      completed|failed|none) printf '  job %s\n' "$st"; return 0 ;;
      down) warn "importer stopped answering — it OOMs on large pushes; restart it and re-POST (it resumes from the watermark)"; return 1 ;;
    esac
    sleep 15
  done
  warn "gave up waiting after two hours"
}

# ── down ─────────────────────────────────────────────────────────────────────
stage_down() {
  tmux -L "$PROJECT" kill-server >/dev/null 2>&1 || true
  # -v: keeping the volume would silently mix corpora across runs.
  ( cd "$REPO_ROOT" && _compose down -v --remove-orphans ) >/dev/null 2>&1 || true
  rm -f "$WORK/corpus.db" "$WORK/apikey" "$WORK/cookies.txt"
  say "stage down"
}

# ── shots ────────────────────────────────────────────────────────────────────
# Only the shots that are aggregate by construction. Adding an id here is a
# privacy decision, not a scheduling one — re-read the header first.
AGGREGATE_SHOTS="${AGGREGATE_SHOTS:-memory-map-view}"

stage_shots() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/api/_internal/features" || true)" = "401" ] \
    || die "stage is not up — run '$0 up' first"
  _use_node
  cd "$REPO_ROOT/video"
  [ -d node_modules/playwright ] || die "playwright not installed here — see video/README.md"
  say "capturing: $AGGREGATE_SHOTS"
  # Through video/kit.sh, which runs the kit off the CI-Common checkout on disk.
  # This was `npm run capture` until 2026-08-08, back when video/package.json
  # installed the kit from GitHub Packages; that path is gone, so the npm script
  # is gone with it and there is nothing named `ci-video` on PATH to fall back
  # to. kit.sh announces which kit answered but does not refuse a stale one —
  # the shots this produces are reviewed by hand against the aggregate-only rule
  # before they are committed, which is the check that matters here.
  APP_URL="http://localhost:$WEB_PORT" "$REPO_ROOT/video/kit.sh" capture --only "$AGGREGATE_SHOTS"
  warn "now OPEN every changed PNG and check it against the aggregate-only rule before committing"
  git -C "$REPO_ROOT" status --porcelain video/assets/shots/ || true
}

case "${1:-up}" in
  up)    stage_up ;;
  down)  stage_down ;;
  shots) stage_shots ;;
  *)     die "usage: $0 {up|down|shots}" ;;
esac
