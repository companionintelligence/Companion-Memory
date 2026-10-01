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

# The ~85 database-backed be-api suites SKIP SILENTLY without a database, so
# `make test` can pass having run none of them. This starts a throwaway Postgres
# in Docker, runs them against it with CI_REQUIRE_DB=1 (a missing database
# FAILS instead of skipping), and fails on any unexplained skip or DB crash.
# Never uses .env. See docs/CI.md.
make test-db                                  # or ARGS='src/domains/import', KEEP=1

# The native suites, which `make test` does NOT cover (each checks its own
# toolchain first — JDK 21 + an Android SDK via ANDROID_HOME; cargo + GTK/WebKit)
make test-android   # gradlew testDebugUnitTest — :app + the 3 :ci-capacitor-* modules
make test-desktop   # cargo test in frontend/apps/desktop/src-tauri

# Build images (ENV=local|staging|production, default local;
# GPU=cpu|cuda|rocm, auto-detected)
make build
make build IMAGE=api    # just one image, not the whole ENV-appropriate set. Valid:
                        # api gateway setup-database database object-store
                        # setup-secrets summary hbpe
make build DRY_RUN=1    # print the exact docker build commands — every --build-arg
                        # and, on a cuda/rocm host, the wheel-image tags — without running Docker
```

**Four of those targets are one-line delegations to `scripts/xtask/`, a TypeScript program
run under `tsx`: `build`, `dev`, `test` and `test-db`.** Their logic is no
longer in the Makefile — read the recipe before editing it. Dispatch, `--help` and signal
handling are in `scripts/xtask/index.ts`; one file per subcommand under `commands/`; shared
pieces under `lib/` — `exec.ts` (`run()` fail-fast / `tryRun()` tolerant), `gpu.ts` (GPU
detection + the HBPE wheel-tag and build-arg derivation), `images.ts` (image repo names,
`TAG`, the `ci.source-tree` sidecar stamp), `uv.ts` (the uv pin, read from `pyproject.toml`),
`identity.ts` (`REPO` / `PROJECT_NAME`). Every subcommand takes `--help` and validates its
arguments. Its unit tests run from the repo-root `yarn test` and are reached by `make test`,
because the root `package.json` now declares `test` and `typecheck` scripts and so is picked
up by `yarn workspaces foreach --all`; the root `tsconfig.json` (`include: scripts/**/*.ts`,
bumped to `target: ES2022`) is what typechecks them. Every other Makefile target is untouched
and `make help` still lists them all.

**`health` is deliberately NOT ported.** It is the toolchain diagnostic, and a prerequisite
checker must not require the prerequisites — a ported version died with a raw yarn error on a
checkout that had not run `make install` yet. It stays pure shell in the Makefile, and
`xtask dev` shells out to `make health` exactly as the old `$(MAKE) health` line did.
`distribute-license` and `clean-license` also stay shell and stay **public** targets:
`.github/workflows/e2e.yml`, `video/stage.sh`, `video/stage.real-corpus.sh` and
`video/README.md` all invoke `make distribute-license`, and `xtask build` calls back into
both. Four pins stay in the Makefile in their exact `NAME := value` / `NAME ?= value` form
because the three wheel-publish scripts in `backend/apps/hbpe/` `sed` them out by name —
`FLASH_ATTN_VERSION`, `LLAMA_CPP_PYTHON_REF`, `LLAMA_CPP_PYTHON_VERSION`,
`AMDGPU_WHEEL_TARGETS`. `lib/gpu.ts` does not copy them; it reads them back out of the
Makefile's text the same way, and throws if a pin has gone missing.

`make dev` runs `make health` first (node present and matching `.nvmrc`, yarn matching
`packageManager`, `uv` present — any mismatch exits 1), then hard-fails unless `overmind`,
`caddy` (admin API live on `:2019`) and `ollama` (on `:11434`) are present — those three
checks now live in `scripts/xtask/commands/dev.ts`.

**CI is `workflow_dispatch`-only — no exceptions, as of 2026-09-17.** Nothing
runs on push, pull request, tag or schedule, so an absent check means nobody
dispatched it, not that anything passed. Start one with
`gh workflow run <file> --ref <branch-or-tag>`.

Until 2026-09-17 there were four exceptions — `pr-gate.yml` on every PR,
`benchmark-unit.yml` on `scripts/benchmark/**` changes, and the two tag-triggered
release lanes. `pr-gate.yml` was deleted (its own header comment called this
exact revert "one move"; deleting it was that move) to cut the GitHub Actions
bill, and the other three were gated to `workflow_dispatch` the same day via
`ci-local gate --repo CI-Server --apply`. `main`'s branch protection was updated
in the same change to stop requiring the six status checks only `pr-gate.yml`
ever produced — **nothing gates a merge now, automatically or by review.**

**`docs/CI.md` holds the only maintained trigger table and per-workflow
notes, including the release-lane dispatch commands that replaced the tag-push
auto-trigger.** Do not restate counts or exception lists here: this file used
to carry its own copy and it went stale within weeks, twice. Re-derive rather
than quote:

```bash
grep -lE '^[[:space:]]+(pull_request|push|schedule):' .github/workflows/*.yml   # should print nothing
gh api repos/companionintelligence/CI-Server/branches/main/protection --jq '.required_status_checks, .required_pull_request_reviews'
```

**`publish.yml` must be dispatched on a release TAG, never on `main`.** Its
`Resolve VERSION from tag` steps do `tag="${GITHUB_REF#refs/tags/}"`, so on a
branch ref `VERSION` becomes the literal `refs/heads/main` — not a legal image
tag. The `Refuse to publish a non-release ref` guard — first step of **all three**
of its jobs (`verify-ci-passed`, `build`, `merge-and-register`; this said "both"
when there were two), before any checkout, matching `GITHUB_REF`
against the workflow-level `RELEASE_TAG_RE` — now rejects that in seconds
instead of after the two `timeout-minutes: 150` matrix legs (`ubuntu-latest`,
`ubuntu-24.04-arm`) have built everything. The mistake is cheap now, not
correct: the run still ends red and nothing is released. `docs/CI.md`'s
generated "Cut a release" block still says `--ref main` — it is wrong; see the
hand-maintained note in that file.

**The release gate is a LIST now, not just `ci.yml`.** `verify-ci-passed` loops
over a `GATED_WORKFLOWS` env block in `publish.yml` (`<workflow>:<required|advisory>`
per line) and fails closed on a malformed entry. Required today: `ci.yml` and
`migration-integrity-check.yml`; `e2e.yml` is **advisory** — it only warns, because
its last green run predates its gating to `workflow_dispatch`, so until someone
flips that one word the gate does NOT prove the app works end to end at the
published commit. `skip_test_gate=true` now REFUSES a blank `bypass_reason` and
writes the reason into the run's step summary. Read the list from the file rather
than from this paragraph; adding a gate is one line there.

**`codeql.yml` is now `workflow_dispatch`-only** (an earlier revision of this
file said push/PR/cron — that is stale). It was gated because it failed every
run for reasons unrelated to any change: the scan completes, then the upload is
rejected with `Code Security must be enabled for this repository to use code
scanning`. TestFlight is `mobile-release.yml` (tag or dispatch), not Xcode Cloud.

**Nothing gates a merge — not CI, not reviews.** This has flipped twice: it was
true before 2026-09-08, false (six `pr-gate.yml` job names required) from
2026-09-08 to 2026-09-17, and is true again now that `pr-gate.yml` is gone and
those six were dropped from branch protection in the same change. See
`docs/qa/` for the release QA programme, the measured baseline, and what a
gate would cost if one were reintroduced.

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

**Never let a comment line start with `-- migrate:up` or `-- migrate:down`.** dbmate finds its directives with a line-anchored regex, so prose that wraps onto one is a directive. Since dbmate 2.29 each extra `-- migrate:up` opens a new section, and the file fails with `dbmate requires each migration to define a down block`. That is how 20260930025958 stopped `migrate` once #2865 took dbmate from 2.27 to 2.36. In prose, quote the word (`` -- `migrate:up` ``). `bin/check-migration-directives.js`, which runs in the same two places, requires exactly one of each per file.

## GraphQL codegen

`backend/apps/api/src/domains/graphql/__generated__/schema.graphql` and everything under
`frontend/apps/web/src/graphql/` (`graphql.ts`, `gql.ts`, `possibleTypes.ts`, `mocks/`) are
**generated — never hand-edit them.** The resolvers and `*Type.ts` classes are the source of
truth.

**Run `make graphql` and commit its output in the same change.** It runs the two generators in
order (`yarn workspace @ci/be-api graphql:generate`, then `yarn workspace @ci/fe-web
graphql:generate`) — the same two steps, in the same order, that `ci.yml`'s **Check GraphQL
schema and types** job runs before doing `git status --porcelain` and failing on any diff.
Reproduce that check exactly rather than eyeballing it:

```bash
make graphql && git status --porcelain   # must print nothing
```

**A docstring is enough to drift it.** The trigger is not "did I add a field" — anything the
SDL carries counts. `v2026.9.23` was blocked by a single reworded `/** ... */` comment on
`ContentFacets.sourceSystems` that regenerated into web `graphql.ts` and was never committed
(fixed in #2733). If you touched a resolver, a `*Type.ts`, or a `.graphql` document at all,
regenerate.

**Nothing will catch this before the release tag.** Per the CI section above, no workflow runs
on a PR or on a push to `main`, and this job is one of the two `required` gates in
`publish.yml`. So uncommitted codegen merges green, sits in `main`, and first surfaces as a
failed release — burning the tag, since a pushed tag is not moved onto the fix but re-cut as
`vYYYY.M.D.N`.

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
