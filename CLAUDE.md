# CLAUDE.md — CI-Server

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

## Platform role

**CI-Server** sits in the **Appliance** layer of the Companion Intelligence platform.

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`
Issues: <https://github.com/companionintelligence/CI-Engineering/issues>

## What this repo does

Personal database, REST/LLM API, RAG, and HBPE behavioral-prediction engine. The memory brain of the appliance.

## Stack

- NestJS 11 (backend)
- React 19 / Vite (frontend)
- Capacitor iOS + Android shells around the web build (`frontend/apps/ios`, `frontend/apps/android`)
- PostgreSQL 18 + pgvector + TimescaleDB + PostGIS
- Ollama (local LLM / embeddings; an OpenAI-compatible endpoint also works)
- Two Python/FastAPI sidecars, managed as a uv workspace (one root `uv.lock`):
  HBPE (ONNX INT8 + a llama.cpp GGUF labeler) and Summary (summaries + the document parser)
- PGBoss (background job **queue**; its own cron scheduler is off — `schedule: false`
  in `backend/apps/api/src/domains/events/services/PGBossEventService.ts`. Nothing calls
  `boss.schedule()`; every recurring job is a NestJS `@Cron` from `@nestjs/schedule`,
  wrapped by `backend/apps/api/src/common/schedule/decorators/Cron.ts`)
- Minio (object storage)
- Docker Compose

## Key commands

```bash
# Install dependencies (JS + Python: yarn install, then `uv sync --all-packages`)
make install

# Bring up the full per-worktree dev stack (Docker services + migrations
# + Caddy route at <project>.localhost + api/worker/web via overmind)
make dev

# Lint / format / test BOTH stacks (yarn + ruff/mypy/pytest)
make lint
make format
make test

# Run one app's tests directly (only a slice of `make test`)
cd backend/apps/api && yarn test

# The native suites, which `make test` does NOT cover (each checks its own
# toolchain first — JDK 21 + an Android SDK via ANDROID_HOME; cargo + GTK/WebKit)
make test-android   # gradlew testDebugUnitTest — :app + the 3 :ci-capacitor-* modules
make test-desktop   # cargo test in frontend/apps/desktop/src-tauri

# Build images (ENV=local|staging|production, default local;
# GPU=cpu|cuda|rocm, auto-detected)
make build
```

`make dev` runs `make health` first (node present and matching `.nvmrc`, yarn matching
`packageManager`, `uv` present — any mismatch exits 1), then hard-fails unless `overmind`,
`caddy` (admin API live on `:2019`) and `ollama` (on `:11434`) are present.

**CI is `workflow_dispatch`-only, with four exceptions.** Ten of the
fourteen workflows do not run on push, pull request, tag or schedule — for
those, an absent check means nobody dispatched it, not that anything passed.
Start one with `gh workflow run <file> --ref <branch-or-tag>`; see `docs/CI.md`
for the full table. The exceptions (re-verified 2026-09-07):

- **`pr-gate.yml`** — `pull_request` against `main`, no path filter, so it runs
  on **every** PR. Lint (4 lanes) + typecheck (2 lanes) + the `mobile-guards`
  job (two dependency-free Node scripts — Capacitor native sync and iOS plist
  duplicate keys — that otherwise run only from lint-staged, which is inert in
  the agent worktrees). The unit-test and Python lanes stay on dispatch in
  `ci.yml`. Its lint/typecheck jobs reuse `ci.yml`'s job names on purpose, so a
  dispatched `ci.yml` reports the same check contexts.
- **`benchmark-unit.yml`** — `pull_request` **and** push to `main`, but only for
  `scripts/benchmark/**`. It runs `pytest` and *no linter*, which is how 141
  ruff violations landed in that directory unnoticed.
- **`mobile-release.yml`** — push `ios-v*`, `android-v*`, or
  `mobile-release-v*` to upload to TestFlight / Play internal.
- **`desktop-release.yml`** — push `desktop-v*`.

**`publish.yml` must be dispatched on a release TAG, never on `main`.** Its
`Resolve VERSION from tag` steps do `tag="${GITHUB_REF#refs/tags/}"`, so on a
branch ref `VERSION` becomes the literal `refs/heads/main` — not a legal image
tag. The `Refuse to publish a non-release ref` guard — first step of both
`verify-ci-passed` and `build`, before any checkout, matching `GITHUB_REF`
against the workflow-level `RELEASE_TAG_RE` — now rejects that in seconds
instead of after the two `timeout-minutes: 150` matrix legs (`ubuntu-latest`,
`ubuntu-24.04-arm`) have built everything. The mistake is cheap now, not
correct: the run still ends red and nothing is released. `docs/CI.md`'s
generated "Cut a release" block still says `--ref main` — it is wrong; see the
hand-maintained note in that file.

**`codeql.yml` is now `workflow_dispatch`-only** (an earlier revision of this
file said push/PR/cron — that is stale). It was gated because it failed every
run for reasons unrelated to any change: the scan completes, then the upload is
rejected with `Code Security must be enabled for this repository to use code
scanning`. TestFlight is `mobile-release.yml` (tag or dispatch), not Xcode Cloud.

**Nothing gates a merge.** `main`'s branch protection has no
`required_status_checks` block and `required_approving_review_count: 0`, so no
red check blocks anything either. See `docs/qa/` for the release QA programme,
the measured baseline, and a proposal for the minimum gate worth turning on.

See `README.md` for the full prerequisite setup and the complete `make` command reference.

## Package manager

**yarn** for JavaScript/TypeScript — use exclusively; do not mix with npm/pnpm/bun.
**uv** for Python (one `uv.lock` at the repo root covering `backend/apps/{hbpe,summary}`
and `backend/packages/*`; never hand-resolve a conflict in it — `scripts/merge-uv-lock.sh`
is registered as a merge driver, then run `uv lock`).

`frontend/apps/ios`, `frontend/apps/android` and `frontend/apps/desktop` are deliberately
**excluded** from the Yarn workspaces (root `package.json`: `"!frontend/apps/ios"`,
`"!frontend/apps/android"`, `"!frontend/apps/desktop"`)
because Capacitor, CocoaPods, Gradle and Tauri walk a real `node_modules` tree that PnP does not
produce. Each therefore carries its **own** `yarn.lock`. Install and run from inside each app's
own directory — a root install will not materialize them, and "fixing" the exclusion breaks the
native builds.

## Cross-repo connections

- Consumed by: all clients via REST/GraphQL at ci-server.localhost
- Receives data from: CI-Browser-Extension, CI-Capture, and the in-repo mobile shells (`frontend/apps/ios`, `frontend/apps/android` — the standalone CI-Connect repo was retired as `ZARCHIVE-CI-Connect`)
- Has its own native import/datasource tooling at `backend/apps/api/src/domains/import/` (ported from the now-retired CI-Import-Tools, see `ZARCHIVED-CI-Import-Tools`) rather than receiving imports from an external process
- Hub installs it alongside marketplace apps via CI-Hub
- HBPE sidecar reads ci.* and ci_search.* Postgres schemas
- CI-Portal OIDC bearer acceptance is **on by default** (`auth.portal.enabled: true`, issuer `https://hub.ci.computer`) — see `backend/apps/api/config/default.json`

## Database migrations

SQL migration files in `backend/apps/api/db/postgres/migrations/` are hand-written and are the source of truth (applied via dbmate). Update the TypeORM entities to match.

**Never hand-write the timestamp prefix.** Create migration files with `yarn workspace @ci/be-api migrate:make <name>`, which stamps the real UTC time to the second. Hand-picked round timestamps (…120000) have collided across parallel branches; dbmate keys `schema_migrations` on the prefix, so a duplicate breaks `migrate` for everyone. Uniqueness is enforced by `bin/check-migration-versions.js` (runs in lint-staged and before `yarn migrate`). It is plain CommonJS, not TypeScript, because `migrate` runs it inside the production image, which has no devDependencies — keep it dependency-free.

## Python sidecars

- **HBPE** — container port **8002** (`uvicorn ci.hbpe.api:app`), host `8002` by default.
- **Summary** — container port 8001 (`ci.summary.api`), plus the document-parser FastAPI
  (`ci.summary.parser`) on container 8002, mapped to host **8003** to avoid HBPE.

Both read the same Postgres instance. Neither runs a worker process of its own: the NestJS
API is the single scheduler — `@nestjs/schedule` crons in
`domains/python-functions/cron/PythonFunctionCrons.ts` fan out one pg-boss job per user,
`domains/python-functions` POSTs them to `POST /functions/run` in the sidecar, and the
outcome returns over an authenticated callback webhook. Import paths are `ci.hbpe.*` / `ci.summary.*` (PEP 420
namespace packages; no member may ship `src/ci/__init__.py`).

See `CI-Engineering/architecture/HBPE/` for design docs.

## Multi-agent safety

Multiple AI agents work these repos in parallel. Never use `git reset --hard`, `git clean -f`, or any destructive git command without explicit confirmation from the user.

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
