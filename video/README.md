# Companion Memory — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Memory's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

**Videos are built locally, on demand, and the MP4s are not stored.** There is no GitHub Actions
job, no schedule, no uploaded artifact, and no committed `.mp4`. A cut is a build output: render
one when you need it, use it, then delete it. What lives in git is the *input* — the storyboard,
the narration audio, and the screenshots under `assets/shots/`.

> **The storyboard references 9 shots — 18 files — and all of them are committed**, so
> `check` passes without `--allow-slates`. Seven come from the seeded stack below. **Two are
> not captures at all**: `graphic-traces` and `graphic-architecture` are Companion Intelligence's
> own artwork from [ci.computer/memory](https://ci.computer/memory) — see
> [The two graphic plates](#the-two-graphic-plates).
>
> **Sixteen more PNGs are committed and referenced by nothing.** The narrative re-cut took the film
> from 18 scenes to 15 and changed which screens it needs; `splash-screen`, `login-form`, `onboarding-focus`, `feed-overview`,
> `memory-map-view`, `memory-stats`, `insight-detail-view` and `connect-providers` — both viewports
> each — left the storyboard with it. They are kept on purpose (see
> [What is committed](#what-is-committed)), but be clear about what that means: `ci-video capture`
> can only shoot ids the storyboard declares, so **nothing can re-shoot them while they are
> unreferenced**, and they are frozen at 2026-08-07's product. Bringing one back into a scene means
> re-shooting it in the same commit. `memory-map-view` is already out of date that way: CI-Server
> [#1891](https://github.com/companionintelligence/CI-Server/pull/1891) restored the Esri
> attribution control to `Map.tsx` after that shot was taken, so the committed frame shows a
> basemap with no credit on it and the product no longer does.
>
> The old note here said the map was empty because `ci.entities.location_point` is NULL on a fresh
> seed. That is true and it is not the reason. `/memory?view=map` is events-only and plots
> `ci.events.location_coordinates`; the seed never writes that column either. Hazard 13 in
> [`capture.config.mjs`](capture.config.mjs) has the corrected diagnosis and the seed diff that
> would let the stock stage film this scene.

**To re-capture and rebuild, from this repo:**

```bash
./video/make.sh                              # stage the app, capture all 3 passes, check, render
./video/make.sh --no-render                  # capture and check only — much faster
./video/make.sh --only memory-list-view      # re-shoot one shot
./video/make.sh --keep-up                    # leave the stage running to debug against
```

`make.sh` sources [`stage.sh`](stage.sh), which stands the whole appliance up — Postgres 18 with
TimescaleDB/PostGIS/pgvector, 188 migrations, the seed, the API and Vite — runs the three capture
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
> single shell command and `stages.json` cannot express three passes under two identities. Capture
> belongs to `video/make.sh`, above.

## Quick start

Everything below is what the runner does, spelled out — reach for it when you are debugging a
single shot rather than building a whole cut.

Every command goes through [`kit.sh`](kit.sh), which runs video-kit out of the CI-Common checkout
on disk. There is nothing to `npm install` first and no registry token — see
[Which kit answers, and why it is not installed](#which-kit-answers-and-why-it-is-not-installed).

```bash
./video/kit.sh doctor        # verify node / ffmpeg / playwright / hyperframes / fonts
./video/kit.sh install-browser

# with the stage up (see below) — three passes, each explicitly scoped:
./video/kit.sh capture --only memory-list-view,memory-detail-sheet,memory-search-results,memory-graph-view,insights-list
VIDEO_FRESH_USER=1 ./video/kit.sh capture --only onboarding-connect
VIDEO_FRESH_USER=1 ./video/kit.sh capture --only onboarding-trust

./video/kit.sh build         # storyboard.json -> build/{landscape,portrait}/index.html
./video/kit.sh check         # HyperFrames gate: lint, runtime, layout, motion, contrast
./video/kit.sh render        # -> out/ci-memory-landscape.mp4 and out/ci-memory-portrait.mp4
```

> `kit.sh` is the UNGUARDED path — it announces which kit answered but will not refuse a stale
> CI-Common checkout. `./video/make.sh` does refuse, and is what you should use when the shots are
> going to be committed. The three capture lines above are exactly what `capture_all` in
> [`stage.sh`](stage.sh) runs for you.

> **A missing PNG does not fail `build`, but it does fail `check`.** video-kit substitutes a
> branded "capture pending" slate for any shot whose file is absent (`scenes.mjs` `slateUri`), so
> `build` still renders green. Since video-kit 0.1.2, `check` fails on missing
> shot files (`--allow-slates` opts out while drafting) — that is the gate that stops a narrated
> slideshow of placeholders shipping as a product video. `kit.sh status` lists what is missing.

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

Capture runs three times on purpose, and **every pass names its shots explicitly** — including the
first. `ci-video capture` exits 1 if any single shot fails, so an unscoped first pass (which would
attempt all seven shots as `jsmith`, two of them unreachable for that identity) dies before the
other two passes run and leaves `assets/shots/` empty. The three passes in the Quick start block
above are the authoritative list.

1. **authenticated** — the seeded `jsmith`; the five shots behind `ProtectedRoute`. Not
   `/onboarding`, which redirects this identity to `/feed`;
2. **`VIDEO_FRESH_USER=1`** ×2 — the seeded user is already onboarded, so the wizard is only
   reachable from a throwaway account. One capture invocation per onboarding shot, because
   onboarding progress is persisted per user and a shared account would resume mid-wizard.

It was five passes until the narrative re-cut. The signed-out pass (`VIDEO_LOGGED_OUT=1`, for `/`
and `/login`) has nothing left to shoot now that the splash and login scenes are gone, and would be
needed again the moment either comes back — those two routes are wrapped in `RedirectKnownUser` and
send an onboarded user to `/feed`.

**`make.sh` now refuses to shoot when its pass lists and the storyboard disagree**, in both
directions: an id named in a pass that the storyboard does not declare (silently skipped by
`--only`, which is a filter and not a lookup) and a declared shot that no pass names (never
requested, and only visible as a missing-shot failure in `check`, one stage and several minutes
later). That second case is what #1871 shipped.

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
APP_URL=http://localhost:3201 ./video/kit.sh capture --only memory-map-view
```

Verified end state: `ci.events` 200,287 · `ci.communications` 293,291 · `ci.content` 190,722 ·
`ci.browser_activity` 330,017 · `ci.inventory` 2,366 — 1,016,683 rows from 826,478 items —
`ci.entities` 17,649, and 83 events with `location_coordinates`. Two consecutive captures of
`memory-map-view.mobile` were byte-identical, so this shot is as reproducible as the seeded ones.

**The importer process was OOM-killed twice at `CI_PUSH_CONCURRENCY=8` / `batchSize=5000`.** It
resumes from the watermark, so a restart costs only the in-flight batch — but 4/1000 ran to
completion and is the setting above.

## The two graphic plates
<a id="the-two-graphic-plates"></a>

Two scenes are **not pictures of the product**. `your-traces` and `how-it-works` show Companion
Intelligence's own artwork from [ci.computer/memory](https://ci.computer/memory): the
collect-digital-traces graphic, and the architecture explainer from the 2026 Q3 short deck that the
site publishes under *"How does Companion Memory work?"*.

They live under `assets/shots/` because **`shotPath` is the only full-frame image slot the scene
grammar has** — `scene.mark` is intro/outro-only and renders a small square, and `items[].icon` is
a chip glyph. Nothing else in the kit puts an image across the frame. That is a real cost: a
directory the rest of this README describes as "the record of what the product looked like" now
holds two files that are not that, so they are named `graphic-*`, listed in `GRAPHIC_SHOTS` in
[`make.sh`](make.sh), and excluded there from the capture-pass check — with `make.sh` refusing if
a name in that list is not actually used by a scene, so the exclusion cannot outlive its reason.

**Regenerate them, never hand-scale them.** The sources are 1080×1080 and 2500×1236; the shot slot
is 16:9 and stretches whatever it is given, so each plate is composited onto the kit's ground
colour `#041620` at the viewport's own native plate size and the artwork is never distorted:

```bash
SRC=/path/to/downloads   # CI-graphic-CollectDigitalTraces (1080x1080), 2026 Q3 short deck (2500x1236)

ffmpeg -f lavfi -i "color=c=0x041620:s=3840x2160" -i "$SRC/collect-traces.png" \
  -filter_complex "[1:v]scale=1420:1420[g];[0:v][g]overlay=(W-w)/2:900-(h/2):format=auto" \
  -frames:v 1 -y assets/shots/graphic-traces.png
ffmpeg -f lavfi -i "color=c=0x041620:s=1080x1920" -i "$SRC/collect-traces.png" \
  -filter_complex "[1:v]scale=930:930[g];[0:v][g]overlay=(W-w)/2:830-(h/2):format=auto" \
  -frames:v 1 -y assets/shots/graphic-traces.mobile.png

ffmpeg -f lavfi -i "color=c=0x041620:s=3840x2160" -i "$SRC/deck.png" \
  -filter_complex "[1:v]scale=3060:-1[g];[0:v][g]overlay=(W-w)/2:860-(h/2):format=auto" \
  -frames:v 1 -y assets/shots/graphic-architecture.png
ffmpeg -f lavfi -i "color=c=0x041620:s=1080x1920" -i "$SRC/deck.png" \
  -filter_complex "[1:v]scale=960:-1[g];[0:v][g]overlay=(W-w)/2:820-(h/2):format=auto" \
  -frames:v 1 -y assets/shots/graphic-architecture.mobile.png
```

**Those offsets are not taste, they are the two clamps.** A `focus` of the whole plate resolves to
coverScale, and the camera then shows **92.6% of the plate, from (0.036, 0.034)** — so ~3.6% of
each edge is cropped, and the caption scrim owns roughly the bottom quarter of what is left. The
first version of the portrait architecture plate was scaled to fit the full 1080 and lost the left
edge of INPUT SURFACES and the right edge of AGENTS to that crop. Run
`ci-video focus-preview --scene how-it-works --format both` and **look at the picture** after any
change; `--at start` shows the other end of the move.

Two more things about these scenes that are easy to get wrong:

- **Do not set `frame`.** It defaults per format — browser in landscape, phone in portrait — and
  those are the two frames whose aspect matches the plates. Pinning `frame: "browser"` was the
  first attempt and it broke portrait badly: a 16:9 card has to be scaled 3.34× to cover a 9:16
  canvas, which cropped the plate to 34% of itself and left the shot static.
- **`motion` is `drift-down`, not `push-in`.** With a `focus`, a push-in *starts at rest* — on the
  browser card, with chrome and a URL bar. These are graphics, not screenshots of a web page, and
  a frame of chrome around one would say otherwise. `drift-down` starts *at* the focus state, so
  the artwork is the frame from the first frame; where there is no headroom to drift, the kit
  degrades it to an 8% push and prints that in the build log.

## Reading the committed PNGs: what is a mask and what is a bug

A Playwright mask paints a flat `#0A222E` rectangle over an element at the shutter. In a committed
shot that is indistinguishable from a component that rendered nothing, and a screenshot audit has
already mistaken one for the other twice. Before filing an "empty state" against a frame, check it
against this list:

| Shot | The flat rectangle | What it is |
|---|---|---|
| `memory-map-view` *(no longer in the film)* | the 300px column down the left of the map | **A deliberate redaction.** At ≥768px the map renders `TimelineView` there, and against the real archive every card in it is a street address. Masked at the shutter, and it used to be cropped out of the cut as well — the scene was `motion: "hold"` with `focus.landscape` starting at `x = 0.284`, just right of the panel. See hazard 13 in `capture.config.mjs`. ⚠️ **`focus` needs video-kit ≥ 0.4.0** (`src/camera.mjs`); an older kit ignores the key silently and the flat panel stays in frame for the whole scene. The redaction still holds — the rectangle is opaque — but check the kit before you believe the framing. **The scene was cut in the narrative re-cut**, and not for pace: every map render fetches tiles from `server.arcgisonline.com`, which `docs/architecture/third-party-egress.md` records as the one egress a fresh appliance performs with no key and no connector — so in a film about records that stay home, that frame argues with its own narration whatever the caption says. |
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
`video/stage.sh` (and the Quick start block above), `./video/make.sh`, then commit the new PNG.
Forgetting to add it to a pass fails **before the stage starts**, naming the shot — `stage_up`
calls `_verify_shot_lists` first for exactly that reason. Before that guard existed the only signal
was `check` failing on a slate, one stage and several minutes later.

**Editing a narration line is not free, and it used to look free.** `narrate` leaves an existing
mp3 alone — deliberately; they are committed and slow to make — so a rewritten line went on
shipping the old read through `build`, `check` and a full render with nothing to hear it. That is
what `assets/audio/narration.json` is for: it records the line each mp3 is a read of, so
`ci-video status` names the drifted scene and prints the old line beside the new one, and
`ci-video narrate --stale` re-records exactly those. The manifest landed in video-kit 0.11.0, which
this repo could not reach while it installed 0.7.2 from the registry; since that path was retired
`./video/kit.sh status` and `./video/kit.sh narrate --stale` run the kit the render host actually
uses. See [Which kit answers, and why it is not installed](#which-kit-answers-and-why-it-is-not-installed).

And verify the result by listening to it, not by reading the exit status: **edge-tts exits 0 while
writing a silent or truncated file.** Transcribing each mp3 back to text and diffing it against the
storyboard line is the check that actually catches both failure modes at once —
`whisper-cli -m ggml-large-v3-turbo.bin -f <scene>.wav -nt`.

**`before` runs after `waitFor`, not before it.** video-kit's engine order is
`goto` → `waitForSelector(capture.waitFor)` → the `before` actions → shutter, so `before` means
"before the shutter". `capture.waitFor` must name a selector present on the **first** rendered
state after `goto`; every state a `before` click navigates to is guarded by a `waitFor` *action*
inside `before`. Putting a post-navigation selector in `capture.waitFor` deadlocks for 25s, drops
the shot, and renders a "capture pending" slate.

## Where each claim in the film is checked

The narration makes claims about the product. Each one is checkable, and this is
where — so the next person editing a line knows what they are editing against
and does not have to re-derive it.

| Line | Checked against |
|---|---|
| *"the whole store narrows in place. Nothing is uploaded"* | `backend/apps/api/src/domains/search-next` and `…/memory` contain no outbound HTTP; the query is GraphQL to the local API against Postgres |
| *"one MCP server that answers only to you"* | `domains/mcp/services/McpServerService.ts` registers a server named **`companion-memory`** — the chip's value verbatim — with `GraphQLToolAdapter` turning the GraphQL surface into its tools |
| *"Hourly, daily, weekly"* | `backend/apps/summary/src/system_schedules.py`: `5 * * * *`, `10 0 * * *`, `15 0 * * MON` |
| *"on a model you host"* | `summary-service` is a container in this repo's own `docker-compose.yml`, pointed at the endpoint from Settings → Model, which defaults to Ollama on the host gateway |
| *"Postgres + pgvector"* | `infrastructure/database/Dockerfile` installs `postgresql-18-pgvector` |
| *"your mail, your calendar and your photos"* | **on screen** — the framing keeps the provider cards' own caption lines, and Google's reads "Gmail, Calendar, Drive, Photos, and YouTube" |
| `Monthly fee $0` | **not checkable in this repo** — there is no billing code here, which is weak evidence rather than proof. It is checkable in the catalogue entry this storyboard's `app.marketplaceId` points at: `CI-Marketplace/apps/ci-memory/config.json` carries `"pricing": { "type": "free" }` |

Two lines were corrected during the rewrite because the **frame did not support
them**, which is the check that no amount of code-reading performs:

- `the-record` said *"…and exactly when"*. At this framing the `STARTS`/`ENDS`
  dates sit under the caption scrim, so the line named something the frame does
  not show. It now names what it does.
- `it-notices` said *"Overnight it reads your week"*. Both cards this shot frames
  are badged **HOURLY**. Hence the three cadences above.

**Read the rendered frame, not the preview, before believing a line.**

## Narration prosody

Since video-kit 0.14.0 the kit gives each scene kind a default rate and pitch,
and `assets/audio/narration.json` records the prosody each mp3 was read at
alongside its text — so changing a scene's register is detectably stale in the
same way changing its words is. **This film has adopted the house register**
(`ci-video narrate --restyle`): intro `-6%`, feature `-5%`, screen `-3%`,
outro `-8%`.

**It is not free, and the cost is runtime.** Under `meta.pacing: "fit"` a slower
read does not create dead air — the scene is sized from the read — so what a
slowdown spends is length. Adopting the register added **4.2s** to this film,
which is most of the way to the 105s ceiling on its own. Two narration lines were
tightened to pay for it, both of which were narrating a list the frame already
prints: `your-traces` no longer recites "mail, calendar, photos, purchases" over
a graphic of two dozen service marks, and `how-it-works` no longer reads out the
box labels of the diagram behind it.

The kit's own note on those defaults is worth heeding: they were chosen from the
measured rate/duration curve, **not from listening tests**. `meta.prosodyByKind`
and per-scene `prosody` are the levers if the register is wrong.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `./video/kit.sh narrate`.

## What is committed

`assets/shots/*.png` and `assets/audio/*.mp3` are **meant** to be committed — they are the record
of what the product looked like, and captures are byte-stable, so a diff in them means the UI
genuinely changed. They are also what lets anyone render a cut without standing up the whole
appliance.

Both are there now: the audio — one mp3 per scene and `narration.json`, which records **which line
each mp3 is a read of**, so an edited line reports itself by name instead of silently shipping the
old recording — and **all 30 PNGs**, of which the storyboard currently references 14.

`memory-map-view{,.mobile}` came from [the real-corpus stage](#the-real-corpus-stage) and are the
only frames in the repo taken against real personal data; they are aggregate-only by construction
— clusters and counts, no labels, no panel. They are also, with the other seven unreferenced
shots, no longer in the film.

**Unreferenced PNGs are kept, and that is a deliberate trade rather than an oversight.** Deleting
them would throw away a 45-minute, 826,478-item corpus load for the map pair, and the shot library
is an input anyone can render from — `video/.gitignore` does *not* exclude `assets/shots/`, which
is deliberate and load-bearing: only a few of the thirteen CI products have a working capture stage,
so gitignoring the shots would mean nobody but the stage's author could ever render the cut. The
cost is that an unreferenced shot cannot be re-captured (capture only knows ids the storyboard
declares) and therefore silently ages. Treat every one of them as **dated 2026-08-07 until
re-shot**, and re-shoot in the same commit that brings one back.

Unreferenced *audio* is handled the other way: `ci-video status` reports an mp3 belonging to no
scene as an orphan, and the fifteen the re-cut left behind were deleted rather than kept, because a
narration track is cheap to regenerate from the storyboard and an orphan one is only ever
confusing.

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
  "comment": "The storyboard references 9 shots (18 files), all committed — seven captured, two committed graphic plates from ci.computer/memory that capture cannot produce and make.sh's GRAPHIC_SHOTS list excludes from its pass check, and both cuts render; `check` passes with no --allow-slates. video/make.sh stands up Postgres+PostGIS+pgvector, 188 migrations, the seed, API and Vite in the 3191+ band under its own compose project, then captures THREE passes under two identities (authenticated, VIDEO_FRESH_USER x2) with ENABLE_REQUIRE_SIGNUP_CODES=false, and refuses to shoot at all if its pass lists and storyboard.json disagree in either direction. SIXTEEN further PNGs are committed and referenced by no scene — they cannot be re-captured while unreferenced and are frozen at 2026-08-07's product; memory-map-view is already stale against CI-Server #1891. A SECOND STAGE, video/stage.real-corpus.sh, is what produced the map pair, loading the owner's real 826,478-item archive over the importer's GraphQL lane (the default /v1 lane silently drops event geo); it is not needed by the current film. AGGREGATE VIEWS ONLY against that stage — no individual may be identifiable in any frame; read the header of that script before adding a shot id to it."
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

## Which kit answers, and why it is not installed

video-kit is **not** a dependency of this project. It is run out of the CI-Common checkout on disk,
by [`make.sh`](make.sh) and [`kit.sh`](kit.sh), which is how all thirteen product repos resolve it.
Both print which one answered, on every run:

```
kit: video-kit 0.15.0 — CI-Common working tree: on main
```

That line is deliberately the same shape as the one CI-Engineering's `tools/` prints (`kitLabel` in
[`tools/lib/workspace.mjs`](https://github.com/companionintelligence/CI-Engineering/blob/main/tools/lib/workspace.mjs)),
so both halves of the pipeline report identically and a single grep for `^kit:` finds either.

**Until 2026-08-08 this repo was the exception**, and it is worth knowing what that cost, because
the failure was silent for six days. `video/package.json` carried
`"@companionintelligence/video-kit": "0.7.2"` from GitHub Packages and `make.sh` *enforced* that
pin. The kit is published by pushing a `video-kit-v*` tag, and between 0.7.2 and 0.15.0 eleven
versions were released into CI-Common's `package.json` and never tagged — so the registry held
0.1.1, 0.1.2 and 0.7.2 and **nothing else**. There was no version of this repo's pin that could
have caught up.

The consequence was not that Companion Memory's film was old. It was that **the film was made by
two different kits at once**: CI-Engineering's fleet runner composed the cut with whatever
CI-Common's `origin/main` carried, while `video/make.sh` captured the shots with 0.7.2 — and
anyone who ran the whole of `make.sh` got a cut composed by 0.7.2, which is a different film from
every other product's and from the one the gallery scores. Both halves printed a version. Nothing
compared them.

So the registry path is gone rather than repaired:

- **What the pin bought, the disk path already provides, and better.** The pin bought an enforced
  exact kit version. `make.sh` pins to CI-Common `origin/<default>` and refuses outright when the
  checkout is behind it or dirty under `packages/video-kit` (`CI_VIDEO_ALLOW_STALE_KIT=1` is the
  deliberate, loud opt-out). That is a stronger guarantee, and it is the same one the other twelve
  products get.
- **It cost auth in a path that otherwise needs none.** `video/.npmrc` plus a `gh auth token`
  fetch, for a private scope, on a machine that has a CI-Common checkout sitting right there.
  Both are deleted.

0.15.0 was tagged and published on 2026-08-08 — the registry now holds it, and `ci-video doctor`'s
`release` check reads green. That publish is provenance: it makes CI-Common's release ledger
honest. It is **not** how this repo gets its kit, and re-pointing this project at the registry
would reintroduce exactly the split described above.

`playwright` stays a real, exactly-pinned devDependency — see
[Why Playwright is pinned exactly](#why-playwright-is-pinned-exactly) above. `make.sh` installs it
through a scratch project rather than running `npm install` in here, so there is no lockfile under
`video/` and there should not be; `.gitignore` explains why.
