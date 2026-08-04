# Companion Memory — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Memory's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

## Quick start

```bash
npm install
npx playwright install --with-deps chromium
npm run doctor        # verify node / ffmpeg / playwright / hyperframes / fonts

# with the stage up (see below) — four passes, in this order:
npm run capture       # seeded jsmith; drives the real UI -> assets/shots/*.png (both viewports)
VIDEO_LOGGED_OUT=1 npm run capture -- --only splash-screen,login-form
VIDEO_FRESH_USER=1 npm run capture -- --only onboarding-focus
VIDEO_FRESH_USER=1 npm run capture -- --only onboarding-connect

npm run build         # storyboard.json -> build/{landscape,portrait}/index.html
npm run check         # HyperFrames gate: lint, runtime, layout, motion, contrast
npm run render        # -> out/ci-memory-landscape.mp4 and out/ci-memory-portrait.mp4
```

> **A missing PNG does not fail the build.** video-kit substitutes a branded "capture pending"
> slate for any shot whose file is absent (`scenes.mjs` `slateUri`), so a storyboard that declares
> shots the stage cannot actually produce still renders green. Run `npm run status` — or just look
> at `assets/shots/` — before believing a cut is complete.

## The stage

CI-Server is not a static front end — capture needs the whole appliance. From the repo root:

```bash
cp .env.default .env
make distribute-license
docker build -f infrastructure/database/Dockerfile       -t ci/database:latest       infrastructure/database
docker build -f infrastructure/setup-database/Dockerfile -t ci/setup-database:latest infrastructure/setup-database
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local up -d database setup-database
yarn workspace @ci/be-api migrate                            # ~147 dbmate migrations
cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts
cd ../../.. && yarn workspace @ci/be-api dev &               # :3030
WEB_PORT=5173 API_PROXY_TARGET=http://localhost:3030 yarn workspace @ci/fe-web dev &   # :5173
```

Those last two lines are the exact processes `playwright.e2e.config.ts` declares in its
`webServer` block; `.github/workflows/video.yml` runs the same sequence.

**Skipping the seed makes every screen in this video an empty state.**

Two feature flags are part of the stage, not the app defaults —
`.github/workflows/video.yml` sets both on the job:

| Variable | Why |
|---|---|
| `ENABLE_ACTIONS=true` | `features.actions` ships `false`, which hides the feed's actions carousel *and* renames its heading to "Questions". The seed already loads real actions. |
| `ENABLE_REQUIRE_SIGNUP_CODES=false` | The fresh-account passes sign up through `/api/signup`, which 400s while signup codes are required. |

Capture runs four times on purpose:

1. **authenticated** — the seeded `jsmith`, films everything behind `ProtectedRoute`;
2. **`VIDEO_LOGGED_OUT=1`** — re-films `/` and `/login`, which redirect a signed-in user to `/feed`;
3. **`VIDEO_FRESH_USER=1`** ×2 — the seeded user is already onboarded, so the wizard is only
   reachable from a throwaway account. One capture invocation per onboarding shot, because
   onboarding progress is persisted per user and a shared account would resume mid-wizard.

Determinism hazards are catalogued at the top of [`capture.config.mjs`](capture.config.mjs).

## Editing the video

Everything editorial lives in [`storyboard.json`](storyboard.json) — scene order, durations,
captions, narration, and which screens appear. The **capture spec for each shot lives in the same
file**, so the script and the screenshots cannot drift apart.

Adding a beat is: add a scene, add its shot's `capture` block, `npm run capture -- --only <id>`,
then `npm run build && npm run render`.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `npm run narrate`.

## What is committed

`assets/shots/*.png` and `assets/audio/*.mp3` **are** committed — they are the record of what the
product looked like, and captures are byte-stable, so a diff in them means the UI genuinely
changed. `out/` is not committed.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
