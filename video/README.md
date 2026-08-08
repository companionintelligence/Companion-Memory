# Companion Memory — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Memory's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

**Videos are built locally, on demand, and the MP4s are not stored.** There is no GitHub Actions
job, no schedule, no uploaded artifact, and no committed `.mp4`. A cut is a build output: render
one when you need it, use it, then delete it. What lives in git is the *input* — the storyboard,
the narration audio, and the screenshots under `assets/shots/`.

> **All 30 shots are committed** (15 shots × 2 viewports), and `npm run check` passes without
> `--allow-slates`. Twenty-eight of them were captured against the seeded stack below. The last
> two — `memory-map-view` and `memory-map-view.mobile` — could not be, and were captured against
> **the real-corpus stage** instead; see [The real-corpus stage](#the-real-corpus-stage).
>
> The old note here said the map was empty because `ci.entities.location_point` is NULL on a fresh
> seed. That is true and it is not the reason. `/memory?view=map` is events-only and plots
> `ci.events.location_coordinates`; the seed never writes that column either. Hazard 13 in
> [`capture.config.mjs`](capture.config.mjs) has the corrected diagnosis and the seed diff that
> would let the stock stage film this scene.

**To re-capture and rebuild, from this repo:**

```bash
./video/make.sh                              # stage the app, capture all 5 passes, check, render
./video/make.sh --no-render                  # capture and check only — much faster
./video/make.sh --only memory-list-view      # re-shoot one shot
./video/make.sh --keep-up                    # leave the stage running to debug against
```

`make.sh` sources [`stage.sh`](stage.sh), which stands the whole appliance up — Postgres 18 with
TimescaleDB/PostGIS/pgvector, 188 migrations, the seed, the API and Vite — runs the five capture
passes, and tears it all down again on the way out, including on failure. It picks free ports in
the 3191+ band and uses its own compose project, so it will not collide with a dev stack someone
else is running. See "The stage" below for what it does and why.

**To render a cut from the shots already committed** — no stage, no Docker — from a CI-Engineering
checkout on the same machine:

```bash
node tools/make-videos.mjs companion-memory            # build both cuts from committed shots
node tools/make-videos.mjs --list                      # what else it can build
```

It resolves video-kit from the CI-Common checkout on disk, so there is no npm registry, no token,
and no `403` — which is the reason CI never managed to produce a video in the first place.

> That runner **renders only**; it refuses `--capture` by design, because staging an app is not a
> single shell command and `stages.json` cannot express five passes under three identities. Capture
> belongs to `video/make.sh`, above.

## Quick start

Everything below is what the runner does, spelled out — reach for it when you are debugging a
single shot rather than building a whole cut.

```bash
npm install
npx playwright install --with-deps chromium
npm run doctor        # verify node / ffmpeg / playwright / hyperframes / fonts

# with the stage up (see below) — five passes, each explicitly scoped:
npm run capture -- --only feed-overview,memory-list-view,memory-detail-sheet,memory-search-results,memory-graph-view,memory-stats,insights-list,insight-detail-view,connect-providers
VIDEO_LOGGED_OUT=1 npm run capture -- --only splash-screen,login-form
VIDEO_FRESH_USER=1 npm run capture -- --only onboarding-focus
VIDEO_FRESH_USER=1 npm run capture -- --only onboarding-connect
VIDEO_FRESH_USER=1 npm run capture -- --only onboarding-trust

npm run build         # storyboard.json -> build/{landscape,portrait}/index.html
npm run check         # HyperFrames gate: lint, runtime, layout, motion, contrast
npm run render        # -> out/ci-memory-landscape.mp4 and out/ci-memory-portrait.mp4
```

> **A missing PNG does not fail `build`, but it does fail `check`.** video-kit substitutes a
> branded "capture pending" slate for any shot whose file is absent (`scenes.mjs` `slateUri`), so
> `npm run build` still renders green. Since video-kit 0.1.2, `npm run check` fails on missing
> shot files (`--allow-slates` opts out while drafting) — that is the gate that stops a narrated
> slideshow of placeholders shipping as a product video. `npm run status` lists what is missing.

## The stage

CI-Server is not a static front end — capture needs the whole appliance.
**[`stage.sh`](stage.sh) does all of this for you**; `./video/make.sh` sources it. What follows is
the same recipe by hand, for when you are debugging the stage itself rather than using it:

```bash
cp .env.default .env
make distribute-license
docker build -f infrastructure/database/Dockerfile       -t ci/database:latest       infrastructure/database
docker build -f infrastructure/setup-database/Dockerfile -t ci/setup-database:latest infrastructure/setup-database
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local up -d database setup-database
yarn workspace @ci/be-api migrate                            # 188 dbmate migrations
cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts
cd ../../.. && yarn workspace @ci/be-api dev &               # :3030
WEB_PORT=5173 API_PROXY_TARGET=http://localhost:3030 yarn workspace @ci/fe-web dev &   # :5173
```

Two differences worth knowing when you compare the two. By hand you get the conventional ports and
compose project; `stage.sh` deliberately does not, because these clones are shared — it picks free
ports from 3191 up and namespaces its containers under `civideo-ci-memory`, so it can never adopt
or tear down a stack someone else is running. And `stage.sh` health-checks *through* Vite at
`/api/_internal/features`, treating **401 as success** — that endpoint is auth-gated, so waiting
for a 200 waits forever.

Those last two lines are the exact processes `playwright.e2e.config.ts` declares in its
`webServer` block.

**Skipping the seed makes every screen in this video an empty state.**

You only need the stage to **re-capture**. Building a cut from the shots already committed under
`assets/shots/` needs none of it — that is the point of committing them.

One feature flag is part of the stage, not the app defaults. Export it before capturing:

| Variable | Why |
|---|---|
| `ENABLE_REQUIRE_SIGNUP_CODES=false` | The fresh-account passes sign up through `/api/signup`, which 400s while signup codes are required. |
| ~~`ENABLE_ACTIONS=true`~~ | No longer required. `features.actions` now ships `true` (`config/default.json:162`), so the feed's actions carousel and its "Actions" heading are on by default. Harmless if you still set it. |

Capture runs five times on purpose, and **every pass names its shots explicitly** — including the
first. `ci-video capture` exits 1 if any single shot fails, so an unscoped first pass (which would
attempt all fifteen shots as `jsmith`, five of them unreachable for that identity) dies before the
other four passes run and leaves `assets/shots/` empty. The five passes in the Quick start block
above are the authoritative list.

1. **authenticated** — the seeded `jsmith`; the nine filmable shots behind `ProtectedRoute`. Not
   `/`, `/login` or `/onboarding`, which redirect this identity to `/feed`; and not
   `memory-map-view`, which the seed cannot populate (hazard 13) and whose content-gated `waitFor`
   would therefore take the other nine shots down with it;
2. **`VIDEO_LOGGED_OUT=1`** — `/` and `/login`, which redirect a signed-in user to `/feed`;
3. **`VIDEO_FRESH_USER=1`** ×3 — the seeded user is already onboarded, so the wizard is only
   reachable from a throwaway account. One capture invocation per onboarding shot, because
   onboarding progress is persisted per user and a shared account would resume mid-wizard.

Determinism hazards are catalogued at the top of [`capture.config.mjs`](capture.config.mjs).

## The real-corpus stage
<a id="the-real-corpus-stage"></a>

The seed is a 64-person fixture. It is the right stage for every screen in this cut except one, and
it is the wrong stage for any claim about scale. `memory-map-view{,.mobile}` were captured against
the owner's real archive — **826,478 items, 23 sources** — loaded into a throwaway appliance.

**The corpus never leaves this machine and no third party is called.** Geocoding is deliberately
NOT run: 83 of the 826,478 items carry genuine WGS84 coordinates already (79 Uber trips, 4 Google
Maps places) and those are what the committed map plots. Forward-geocoding the ~1,400 calendar
events that carry a `Location` string would add roughly 700 more pins, but it posts those strings
to Google's Geocoding API — a data-egress decision for the owner to make, not the capture job.

### The rule that governs what may be filmed against it

**Aggregate views only. No individual may be identifiable in any frame.** Film entity-graph and
density visualisations, counts, totals, source coverage, settings, and the map at a zoom where no
street address is legible. Do not film message threads or lists, email bodies, contact or people
lists, photo grids, purchase history, calendar entries with attendee names, filenames containing
personal names, or a map zoomed to a residence. If a scene can only be satisfied by one of those,
**leave it uncaptured and say so** — the seeded shot is the honest stand-in, because its people are
fictional.

That rule is why the desktop map masks its left panel: at >=768px `MapView` renders a 300px
`TimelineView` rail, and against this corpus every card in it is a street address.

### Recipe

Ports are in the 3191+ band and the compose project is its own, so this never adopts or tears down
a stack another agent is running. Run it from **your own worktree**, never a shared clone.

```bash
# 0. worktree + deps (yarn 4 PnP; the cache is shared, the install is seconds)
git worktree add /tmp/ci-memory-corpus -b <branch> origin/main
cd /tmp/ci-memory-corpus
export PATH="$HOME/.nvm/versions/node/v22.15.1/bin:$PATH"      # .nvmrc is exact
export YARN_CACHE_FOLDER=/Users/<you>/devel/ci/CI-Server/.yarn/cache
YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install

# 1. .env — own ports, own compose project
cp .env.default .env
cat >> .env <<'ENV'
COMPOSE_PROJECT_NAME=civideo-real-memory
DB_HOST_PORT=3202
DATABASE_PORT=3202
PORT=3203
ENABLE_REQUIRE_SIGNUP_CODES=false
ENV

# 2. Postgres. Raise the lock table BEFORE the load — the July 2026 ingest of this
#    same corpus killed a stock Postgres with "out of shared memory".
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
docker compose -p civideo-real-memory -f docker-compose.yml -f docker-compose.local.yml \
  --profile local up -d database setup-database
docker exec -u postgres civideo-real-memory-database-1 \
  psql -U postgres -c "ALTER SYSTEM SET max_locks_per_transaction = 512;"
docker restart civideo-real-memory-database-1
yarn workspace @ci/be-api migrate

# 3. one user, onboarded, plus an API key for the importer
#    POST /api/signup, then UPDATE ci.users SET onboarded=true, role='admin',
#    then POST /api/keys with the returned JWT. The key is shown once.

# 4. drop deferrable indexes for the bulk load, start api + web
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts drop   # run from backend/apps/api
#   api:  cd backend/apps/api && yarn dev                 (:3203)
#   web:  cd frontend/apps/web && WEB_PORT=3201 API_PROXY_TARGET=http://localhost:3203 yarn dev
#   Start both under tmux, not a plain background job: `yarn dev` traps SIGINT and
#   dies with its process group when the shell that launched it is reaped.

# 5. CI-Import-Tools, pointed at a COPY of the corpus (the push writes a watermark
#    back into the SQLite file — never run it against the original archive).
#    The GraphQL lane is mandatory: the default /v1 lane drops event geo, so the
#    map would be empty. ~45 min for 826,478 items.
CI_DB_PATH=/tmp/corpus.db CI_ADMIN_ADDR=127.0.0.1:12009 CI_OIDC_DISABLE=1 \
CI_ALLOW_UNAUTHENTICATED=1 CI_PUSH_TRANSPORT=graphql CI_PUSH_BATCH_SIZE=1000 \
CI_PUSH_CONCURRENCY=4 NODE_OPTIONS=--max-old-space-size=12288 \
  node node_modules/.bin/tsx src/server.ts        # from CI-Import-Tools/backend

curl -X POST http://127.0.0.1:12009/api/wizard/ci-server/sync -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3203","apiKey":"<key>","full":true,"batchSize":1000,"concurrency":4}'
#    `"full": true` IS LOAD-BEARING. The watermark in the SQLite `settings` table is
#    server-agnostic, so an incremental push to a brand-new appliance silently skips
#    the 640,000 items that sit at or before it and you film a fifth of the corpus.

# 6. entities + relationships (the push moves items only), then put the indexes back
curl -X POST http://127.0.0.1:12009/api/wizard/pipeline/run -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3203","apiKey":"<key>","stages":["sync_graph","extract_people","extract_graph"]}'
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts recreate

# 7. capture, aggregate shots only
cd video && APP_URL=http://localhost:3201 npm run capture -- --only memory-map-view
```

Verified end state: `ci.events` 200,287 · `ci.communications` 293,291 · `ci.content` 190,722 ·
`ci.browser_activity` 330,017 · `ci.inventory` 2,366 — 1,016,683 rows from 826,478 items —
`ci.entities` 17,649, and 83 events with `location_coordinates`. Two consecutive captures of
`memory-map-view.mobile` were byte-identical, so this shot is as reproducible as the seeded ones.

**The importer process was OOM-killed twice at `CI_PUSH_CONCURRENCY=8` / `batchSize=5000`.** It
resumes from the watermark, so a restart costs only the in-flight batch — but 4/1000 ran to
completion and is the setting above.

## Reading the committed PNGs: what is a mask and what is a bug

A Playwright mask paints a flat `#0A222E` rectangle over an element at the shutter. In a committed
shot that is indistinguishable from a component that rendered nothing, and a screenshot audit has
already mistaken one for the other twice. Before filing an "empty state" against a frame, check it
against this list:

| Shot | The flat rectangle | What it is |
|---|---|---|
| `memory-map-view` | the 300px column down the left of the map | **A deliberate redaction.** At ≥768px the map renders `TimelineView` there, and against the real archive every card in it is a street address. Masked at the shutter, and meant to be cropped out of the cut as well — the scene is `motion: "hold"` with `focus.landscape` starting at `x = 0.284`, just right of the panel. See hazard 13 in `capture.config.mjs`. ⚠️ **`focus` needs video-kit ≥ 0.4.0** (`src/camera.mjs`); an older kit ignores the key silently and the flat panel stays in frame for the whole 4.5s scene. The redaction still holds — the rectangle is opaque — but check the kit before you believe the framing. |
| every shot with a list | individual `<time>` elements | Relative timestamps ("3:42 PM" / "Jun 14") that move with the clock. |

`feed-overview` used to belong on that list — its 24-hour forecast strip was masked, leaving a dead
grey bar under a live "Tomorrow's Forecast" heading and a full colour legend. That read as a broken
product, so the whole section is now hidden at the shutter instead of masked (hazard 4).

`memory-map-view` also used to mask `.leaflet-control-attribution`, and that mask is now **removed**.
A basemap attribution is a disclosure, not a nuisance — it is the one control that would name Esri
on screen — and masking it is exactly the thing the honesty rule forbids. It also never did
anything: `Map.tsx` sets `attributionControl={false}`, so the element is never in the DOM and the
selector matched nothing. The corner of the committed shot is bare tiles. **The shot was honest;
the product is what shows no attribution.** See hazard 6 in `capture.config.mjs` and
[`docs/architecture/third-party-egress.md`](../docs/architecture/third-party-egress.md).

Nothing else in `assets/shots/` is masked. A flat rectangle anywhere else IS a bug.

## Editing the video

Everything editorial lives in [`storyboard.json`](storyboard.json) — scene order, durations,
captions, narration, and which screens appear. The **capture spec for each shot lives in the same
file**, so the script and the screenshots cannot drift apart.

Adding a beat is: add a scene, add its shot's `capture` block, add the shot id to the right pass in
the Quick start block above, `npm run capture -- --only <id>`, then `npm run build && npm run
render`. Forgetting to add it to a pass is caught by `npm run check`, which fails on a shot with
no PNG. Commit the new PNG.

**`before` runs after `waitFor`, not before it.** video-kit's engine order is
`goto` → `waitForSelector(capture.waitFor)` → the `before` actions → shutter, so `before` means
"before the shutter". `capture.waitFor` must name a selector present on the **first** rendered
state after `goto`; every state a `before` click navigates to is guarded by a `waitFor` *action*
inside `before`. Putting a post-navigation selector in `capture.waitFor` deadlocks for 25s, drops
the shot, and renders a "capture pending" slate.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `npm run narrate`.

## What is committed

`assets/shots/*.png` and `assets/audio/*.mp3` are **meant** to be committed — they are the record
of what the product looked like, and captures are byte-stable, so a diff in them means the UI
genuinely changed. They are also what lets anyone render a cut without standing up the whole
appliance.

Both are there now: the audio, and **all 30 PNGs** — 28 from the seeded stage, and
`memory-map-view{,.mobile}` from [the real-corpus stage](#the-real-corpus-stage). Those two are
the only frames in the repo taken against real personal data, and they are aggregate-only by
construction: clusters and counts, no labels, no panel. `video/.gitignore` does *not* exclude `assets/shots/`, which is
deliberate and load-bearing: only a few of the twelve CI products have a working capture stage, so
gitignoring the shots would mean nobody but the stage's author could ever render the cut.

`out/` is **not** committed, and the MP4s are not stored anywhere else either — no artifacts, no
release assets. Re-render when you need one.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.

## The `tools/stages.json` entry

CI-Engineering's `tools/stages.json` still says `"capture": null` for this product and repeats the
retired "every `location_point` is NULL" diagnosis. Replace that entry with:

```json
"companion-memory": {
  "name": "Companion Memory",
  "repo": "CI-Server",
  "capture": "video/make.sh",
  "captureRealCorpus": "video/stage.real-corpus.sh",
  "comment": "All 30 shots are committed and both cuts render; `check` passes with no --allow-slates. TWO STAGES. video/make.sh stands up Postgres+PostGIS+pgvector, 188 migrations, the seed, API and Vite in the 3191+ band under its own compose project, then captures FIVE passes under three identities (authenticated, VIDEO_LOGGED_OUT, VIDEO_FRESH_USER x3) with ENABLE_REQUIRE_SIGNUP_CODES=false — it produces 28 of the 30 shots. It deliberately does NOT capture memory-map-view: the seed writes no ci.events.location_coordinates, so that shot's content-gated waitFor times out and takes the other nine shots in its pass with it. video/stage.real-corpus.sh produces those two, loading the owner's real 826,478-item archive over the importer's GraphQL lane (the default /v1 lane silently drops event geo). AGGREGATE VIEWS ONLY against that stage — no individual may be identifiable in any frame; read the header of that script before adding a shot id to it."
}
```

`make-videos.mjs` renders only, so neither script is invoked by the cross-product runner — but the
entry is where the next person looks to find out how this product boots, and the stale one sends
them to fix the wrong file.

## Why Playwright is pinned exactly

`video/package.json` pins `playwright` to an exact version, not a range.

Captures are byte-stable — that is what makes committing the shots worthwhile, because a UI change
then lands as a reviewable image diff instead of noise. But that property only holds **within one
Chromium build**. A `^1.58.0` range resolved to 1.62.1 on one machine and rewrote every committed
shot in a repo by 0.07–0.47% of pixels: pure text antialiasing, no layout change, and completely
indistinguishable from a real UI change in review.

So the range is gone. Re-pin deliberately when you want the newer browser, and re-capture the whole
shot set in the same commit.

## Why video-kit is pinned exactly, and which kit answered

Same argument, one layer up. `video/package.json` pins `@companionintelligence/video-kit` to an
exact version too, and `make.sh` prints which one actually resolved on every run:

```
kit: video-kit 0.7.2 — GitHub Packages registry: pinned 0.7.2
```

That line is deliberately the same shape as the one CI-Engineering's `tools/` prints (`kitLabel` in
[`tools/lib/workspace.mjs`](https://github.com/companionintelligence/CI-Engineering/blob/main/tools/lib/workspace.mjs))
and the one the generic `make.sh` prints, so both halves of the pipeline report identically and a
single grep for `^kit:` finds either.

**This repo is the one that installs the kit from the registry.** The other eight video repos
resolve it from the CI-Common checkout on disk, so their hazard is a working tree parked on a stale
branch — that is what the `── which kit answered ──` guard in the generic runner refuses on
(CI-Common [#56](https://github.com/companionintelligence/CI-Common/pull/56)), and it has nothing to
check here. The registry hazard is a floating range instead: `npm install` takes the newest matching
version at the time of the run, the kit decides pacing, camera and composition, and this repo
commits its shots. A kit that changed on its own re-renders the cut and lands in review looking like
a real UI diff — next to the two documented drift shots, which is a bad place to have to tell them
apart.

Two details worth knowing before you change the pin, because they are not what you would guess:

- **`^0.7.0` floated patches, not minors.** npm's caret pins the minor on `0.x`, so that spec meant
  `>=0.7.0 <0.8.0`. It did silently move 0.7.0 → 0.7.2 (one of which was a pacing change), but it
  could never have reached 0.9.1 or 0.10.0.
- **The registry only carries 0.1.1, 0.1.2 and 0.7.2.** Publishing is driven by a `video-kit-v*`
  tag; 0.8.0 through 0.10.0 were released in CI-Common's `package.json` but never tagged, so there
  is nothing to install.

So this repo sits on the 0.7.x line while the disk-resolved repos are on 0.10.0. Getting current is
a deliberate, separate change: tag and publish the kit, bump the pin here, then re-shoot and commit
the shots in the same commit as the bump — never the bump alone.

There is no lockfile under `video/` and there should not be; `.gitignore` explains why. That
rationale depends on the pins in `package.json` being exact, which — as of this section — they now
both are.
