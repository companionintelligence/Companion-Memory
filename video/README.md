# Companion Memory — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Memory's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

**Videos are built locally, on demand, and the MP4s are not stored.** There is no GitHub Actions
job, no schedule, no uploaded artifact, and no committed `.mp4`. A cut is a build output: render
one when you need it, use it, then delete it. What lives in git is the *input* — the storyboard,
the narration audio, and the screenshots under `assets/shots/`.

> **28 of 30 shots are committed** (14 shots × 2 viewports), captured against a real seeded stack.
> The two that are missing are `memory-map-view` and `memory-map-view.mobile`, and they are missing
> **on purpose**: with the stock seed the map has nothing on it, so filming it would ship an
> explicit "No memories yet" empty state under the caption "Anything with a place gets one." The
> full diagnosis — including the one-line seed change that would fix it — is hazard 13 in
> [`capture.config.mjs`](capture.config.mjs).
>
> Consequence: `npm run build` is green (the map scene renders a "capture pending" slate) but
> `npm run check` **fails** on the two missing files until either the seed is fixed and the shot
> taken, or the `memory-map` scene is cut from the storyboard the way the gallery scene was.
> `npm run check -- --allow-slates` opts out while that decision is pending.

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
npm run capture -- --only feed-overview,memory-list-view,memory-detail-sheet,memory-search-results,memory-graph-view,people-directory,insights-list,insight-detail-view,connect-providers
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
   `memory-map-view`, which the seed cannot populate (hazard 13);
2. **`VIDEO_LOGGED_OUT=1`** — `/` and `/login`, which redirect a signed-in user to `/feed`;
3. **`VIDEO_FRESH_USER=1`** ×3 — the seeded user is already onboarded, so the wizard is only
   reachable from a throwaway account. One capture invocation per onboarding shot, because
   onboarding progress is persisted per user and a shared account would resume mid-wizard.

Determinism hazards are catalogued at the top of [`capture.config.mjs`](capture.config.mjs).

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

Both are there now: the audio, and **28 of the 30 PNGs** (`npm run status` lists the two that are
not — see the note at the top). `video/.gitignore` does *not* exclude `assets/shots/`, which is
deliberate and load-bearing: only a few of the twelve CI products have a working capture stage, so
gitignoring the shots would mean nobody but the stage's author could ever render the cut.

`out/` is **not** committed, and the MP4s are not stored anywhere else either — no artifacts, no
release assets. Re-render when you need one.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.

## Why Playwright is pinned exactly

`video/package.json` pins `playwright` to an exact version, not a range.

Captures are byte-stable — that is what makes committing the shots worthwhile, because a UI change
then lands as a reviewable image diff instead of noise. But that property only holds **within one
Chromium build**. A `^1.58.0` range resolved to 1.62.1 on one machine and rewrote every committed
shot in a repo by 0.07–0.47% of pixels: pure text antialiasing, no layout change, and completely
indistinguishable from a real UI change in review.

So the range is gone. Re-pin deliberately when you want the newer browser, and re-capture the whole
shot set in the same commit.
