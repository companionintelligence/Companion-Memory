# CI-Server Test Strategy

> Status: **active — seed.** Foundation for ratcheting coverage toward the `planning.md` → CI-Server target of **>70% line coverage**.
> Owner: CI-Server.

## 1. Today (re-surveyed 2026-08-23)

| Layer | Tooling | What exists |
|---|---|---|
| Unit / controller | Jest + `@nestjs/testing` + `supertest` (`backend/apps/api/jest.config.mjs`, swc transform) | **735 spec/test files** colocated with source — 260 `*.spec.ts` plus 475 `*.test.ts` (473 of them under `__tests__/`) — auth, memory bulk-ingest services, maintenance backfills, saved-search sharing, persistence helpers, graphql resolvers, the pipeline stages, the import domain, and more. `yarn workspace @ci/be-api test`. |
| Integration | Jest (same runner), Docker-backed Postgres + Minio via `make dev`. | Used by the `Routes.e2e.test.ts` patterns in `auth/` and `files/`, and by **DB-gated suites** — see §3.1. `AccountPurgeService.integration.spec.ts` additionally needs `DATABASE_ADMIN_PASSWORD`. |
| Browser / E2E | Playwright — `tests/BetaOneLoginFlow.spec.ts` plus 13 specs in `tests/e2e/` (auth, chat, import, mcp-api-key, memory views / search+filter+detail / map-bbox / people, mobile, onboarding, settings-persistence, stats, things). | The frontend additionally has its own vitest + Playwright harness under `frontend/apps/web/src/test/` — 281 `*.test.ts(x)` files under `frontend/apps/web/src`. |
| Coverage gate | Jest `coverageThreshold` | **Set, but scoped — not global.** `jest.config.mjs` carries one entry, `./src/domains/planning/` at 88 statements / 76 branches / 76 functions / 90 lines. §4 explains why it is scoped. |

### Which runner, per workspace — the flag that wastes ten minutes

The two workspaces do **not** share a test runner, and the CLIs reject each
other's flags:

| Workspace | `yarn … test` runs | Filter by path | Do **not** pass |
|---|---|---|---|
| `@ci/be-api` | `DOTENV_CONFIG_PATH=../../../.env jest` | `yarn workspace @ci/be-api test src/domains/asks` | `--run` — jest dies with `Unrecognized option "run". Did you mean "u"?` and exits non-zero, which reads like a broken suite |
| `@ci/fe-web` | `vitest run` | `yarn workspace @ci/fe-web test src/pages/AsksPage` | nothing; `--run` is accepted but redundant, the script already says `run` |

A consent-path or nav change usually touches both. Verified by running each on
2026-08-23.

### The current baseline: two things are red before you start

> **Known flake (backend):** `SessionController` logout (204→404) under parallel
> jest (`domains/auth/__tests__/SessionController.test.ts`) — re-run or
> `--runInBand`; it is not your change.

> **Resolved (was: a red frontend test).** This document used to record
> `src/test/nativeAppConfig.node.test.ts` as reliably red over
> `NSPhotoLibraryUsageDescription`, on the grounds that the test forbade a key
> the Info.plist declared. That contradiction has been settled the other way:
> the test now asserts the key is **present**, deliberately, and the file passes.
> Re-measured 2026-08-26.

> **CI is mostly manual — and the two automatic lanes do not check what you
> would assume.** There are **twelve** workflows under `.github/workflows/`
> (re-verified 2026-08-27), and **nine** are `workflow_dispatch`-only:
> `ci.yml`, `codeql.yml`, `consent-path-gate.yml`, `desktop-build.yml`,
> `e2e.yml`, `migration-integrity-check.yml`, `mobile-build.yml`, `publish.yml`,
> `style-canon-lint.yml`. For those, an absent or
> green check means **nobody dispatched it**, not that the suite passed — run one
> deliberately with `gh workflow run <file> --ref <branch>`.
>
> What runs on its own:
>
> - **`benchmark-unit.yml`** — the only workflow that runs on a **pull request**,
>   path-filtered to `scripts/benchmark/**`. It runs `pytest` and **no linter**,
>   which is exactly how 141 ruff violations reached that directory unnoticed
>   while `ci.yml`'s `python` lane sat undispatched.
> - **`mobile-release.yml` / `desktop-release.yml`** — `push` on `ios-v*` /
>   `android-v*` / `mobile-release-v*` and `desktop-v*` tags. Neither runs on a PR.
>
> **`codeql.yml` is no longer push/PR/cron.** An earlier revision of this
> document said it was; it has since been gated to `workflow_dispatch` because
> every run failed on `Code Security must be enabled for this repository`.
>
> `main` has no `required_status_checks` and `required_approving_review_count: 0`,
> so nothing blocks a merge. See [`../qa/ci-gate-proposal.md`](../qa/ci-gate-proposal.md)
> for the measured cost of that and the minimum gate worth turning on, and
> [`../qa/baseline-2026-08-26.md`](../qa/baseline-2026-08-26.md) for what it let through.

## 2. Where to invest, in order

This is the priority queue. Each item should land its own ratcheted coverage floor in `jest.config.mjs` when complete.

### Tier 1 — must have before G1 ships

1. **`HealthController`** — done (seed).
2. **`AuthService` + Csrf** — auth is the gate to everything else; bugs are silent breakage.
3. **The `/v1` capture ingest controller** — shipped. It is now
   `domains/ingest/controllers/BulkIngestController.ts` with
   `controllers/__tests__/BulkIngestController.test.ts` and
   `domains/ingest/__tests__/Routes.e2e.test.ts`; the standalone
   `EventsIngestController` no longer exists. Keep ratcheting toward **>90% line
   coverage on this controller and its zod schemas** per
   [`event-ingest-spec.md`](event-ingest-spec.md) §7 — noting it now carries ten
   lanes, not one.
4. **`browser-activity` write path** — first capture source migrated through G1; parity tests vs. legacy POST.

### Tier 2 — within one release of G1

5. **`files` upload / presigned URL flow** — only one E2E test today; needs unit coverage for media validation, mime sniffing, sha256 verification.
6. **`devices` + `keys` lifecycle** — registration, rotation, revocation. These are the foundation of multi-device trust.
7. **`llm` OpenAI-compatible endpoints** — `/v1/chat/completions` SSE behavior, `/v1/audio/transcriptions` multipart, error mapping. Used by every wearable + voice client.
8. **`graph` read API** — relational integrity tests so memory entity changes don't silently rot queries.

### Tier 3 — broad coverage push

9. **`position`, `threads`, `questions`, `answers`** — controller-level tests + zod input validation.
10. **`memory/entities/*` services** — repository-layer tests with a Postgres test container.
11. **`onboarding`** — first-run flow, especially around CI-Hub bootstrap.

### Tier 4 — performance + load

12. `/v1/events` batch ingest under load — k6 or vegeta, 1000-event batches sustained.
13. `/v1/timeline` query under realistic graph sizes (10⁶ events, 10⁴ entities).
14. SSE streams (`/v1/chat/completions`, `/v1/responses`) under 100 concurrent clients.

## 3. Conventions

- **Test location**: colocated `__tests__/` next to source (matches existing pattern in `domains/auth/`).
- **Module mocks**: provide via NestJS `Test.createTestingModule({...})` with `{ provide: Service, useValue: mockService }`. See `SessionController.test.ts` for the canonical pattern.
- **HTTP**: `supertest` against `app.getHttpServer()`. Don't spin up actual ports in unit/integration tests.
- **DB-touching tests**: use a per-test Postgres schema; never share a schema across `describe` blocks. Truncate on `afterEach`.
- **Network calls**: forbidden in unit tests. Use `nock` for HTTP mocking when needed.
- **Time**: `jest.useFakeTimers()` for any controller that touches `Date.now()` or schedules.
- **Coverage exclusions**: `index.ts`, `main.ts`, `bootstrap.ts`, type-only files, and `__tests__/` are excluded in `jest.config.mjs`.

### DB-backed suites — the two ways this misleads you

*Most* suites that need Postgres resolve the connection through
`domains/__tests__/support/databaseConnection.ts`, in this precedence:

1. **the suite's own** `<DOMAIN>_TEST_DATABASE_URL`,
2. then `DATABASE_URL`,
3. then the discrete `DATABASE_HOST/PORT/USERNAME/DATABASE/PASSWORD`.

There are **sixteen** per-suite variables, not the two this document used to
name: `ASKS_`, `BROWSER_ACTIVITY_`, `CONNECTIONS_`, `EVENTS_`, `IMPORT_`,
`MEMORY_`, `NOTES_`, `PEERS_`, `PERSISTENCE_`, `PERSONALIZATION_`, `PIPELINE_`,
`PLANNING_`, `PORTABILITY_`, `SCHEDULE_`, `SEARCH_INGRESS_`, `SEARCH_NEXT_`
(each `…_TEST_DATABASE_URL`). Naming one per suite is what lets you point a
single domain at a scratch database without moving the whole app.

**The fallback to `DATABASE_URL` is NOT universal — three suites do not have
it.** They read their variable straight off `process.env` and gate `describe` on
that alone, so setting only `DATABASE_URL` leaves them skipping:

| Suite | Reads |
| --- | --- |
| `planning/services/__tests__/TaskService.tenancy.integration.test.ts` (two `describe` blocks) | `PLANNING_TEST_DATABASE_URL` |
| `notes/__tests__/NoteCapture.integration.spec.ts` | `NOTES_TEST_DATABASE_URL` |
| `schedule/services/__tests__/CandidateService.lifecycle.integration.test.ts` | `SCHEDULE_TEST_DATABASE_URL ?? PLANNING_TEST_DATABASE_URL` |

They also miss the port probe as a result: point one at a URL with nothing
listening and it fails every test instead of skipping. Anything pointing an
environment at a database — `ci.yml`, a runbook, your shell — must set the
per-suite variables, not just `DATABASE_URL`.

**Trap 1 — a skip is not a pass.** The probe answers *"is a port open"*. With no
database the suites `describe.skip` and **jest exits 0**. That is deliberate (a
laptop with no stack must not fail), but it means a green local run, or a green
`ci.yml` run, can have executed none of the DB-backed coverage. `ci.yml`'s
backend job now runs a `services: postgres`, bootstraps the role and extensions,
migrates, and sets all sixteen per-suite variables, so the DB-backed suites do
run there. What still skips in that job is the seven suites gating on
`scratchDatabaseAvailability()`, because `DATABASE_ADMIN_PASSWORD` is
deliberately unset — a cost decision the workflow states in a comment rather
than hides. `consent-path-gate.yml` remains the stronger guarantee for the
consent path: it fails if any suite in scope skips.

**Trap 2 — a database without the migrations FAILS, and looks like your bug.**
"Port open" and "schema correct" are different questions, and only the first is
probed. Point any of those variables at a Postgres that has not been migrated to
this checkout's head and you get a pile of `relation "ci.peer_links" does not
exist`, which reads exactly like a code defect in your change. `.env` hard-codes
`DATABASE_PORT=5432`, so on a machine running several worktree stacks the suites
land on whichever one holds host 5432 — usually a schema no branch describes.
Details and the consent-path recipe:
[`asks-system-guide.md` §7.4](../asks-system-guide.md).

## 4. Coverage ratchet

`jest.config.mjs` now carries a `coverageThreshold`, and it is **scoped rather than
global** — deliberately, and the config says so: the global number is still low, so a
global floor set to it would be a fence around nothing, while a per-domain floor lets a
new domain land with a real one from day one. Today there is exactly one entry:

```js
coverageThreshold: {
  './src/domains/planning/': {
    statements: 88,
    branches: 76,
    functions: 76,
    lines: 90,
  },
}
```

Note the planning floor is set just under what that suite achieves **without** a database,
because `TaskService.tenancy.integration.test.ts` skips unless `PLANNING_TEST_DATABASE_URL`
is set. A floor that assumed the DB-backed run would fail every laptop.

The ratchet rule is unchanged; apply it per path. Every PR that adds tests should:

1. Land the test.
2. Read the resulting coverage number for that path from `yarn test --coverage` output.
3. Update that path's `coverageThreshold` entry to **the floor of that number** (never
   higher than achieved, never lower than current).

This avoids wishful thresholds. The floor only ever moves up. A global entry is still worth
adding once the global number is high enough to fence — that is the open item here, not the
existence of a threshold.

## 5. CI integration

Where things stand: `.github/workflows/ci.yml` has a **Run backend tests** job
(`yarn workspace @ci/be-api test`, no `--coverage`) and a **Run frontend tests** job
(`yarn workspace @ci/fe-web test --coverage`, uploading an `fe-coverage` artifact),
alongside type-check, lint and a Python job (`ruff`, `mypy`, `uv sync --locked`).

Two gaps remain, and they compound:

1. The backend job does not pass `--coverage`, so the ratchet in §4 is never evaluated in CI.
2. The workflow is `workflow_dispatch`-only, so nothing evaluates it on a pull request either.

`CI-Local-CICD` (or a restored `pull_request` trigger) should run the backend suite with
`--coverage --ci` and fail the build on coverage regression. This is the only enforcement
that makes the ratchet stick; until then the thresholds bind only for whoever runs the
suite locally.

The Marketplace install E2E (planning.md G3) lives separately — Playwright + Docker, run against a Hub + Marketplace + fixture-app stack. That is **not** in this Jest config; it lives in `tests/` at the repo root.

## 6. Test data

`make seed` produces the John Smith demo dataset. Avoid relying on it in unit tests — they should each provision their own minimal fixtures so they survive seed schema changes. Reach for the seed only in E2E flows that legitimately need a realistic graph.

## 7. Open questions

- **Test containers vs. shared Postgres?** Today integration tests reuse the dev Postgres. As volume grows, per-test containers (via `testcontainers-node`) will scale better. Decide before coverage passes 40%.
- **Snapshot tests for GraphQL schemas?** The `graph` controller's SDL is autogenerated; a snapshot test would catch unintended schema changes. Recommend yes once `graph` has unit coverage.
- **Mutation testing?** Stryker would tell us whether our coverage numbers reflect real behavioral coverage. Worth piloting once we cross 50% global.
