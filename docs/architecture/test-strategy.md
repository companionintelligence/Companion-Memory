# CI-Server Test Strategy

> Status: **active — seed.** Foundation for ratcheting coverage toward the `planning.md` → CI-Server target of **>70% line coverage**.
> Owner: CI-Server.

## 1. Today

| Layer | Tooling | What exists |
|---|---|---|
| Unit / controller | Jest + `@nestjs/testing` + `supertest` | `auth/__tests__/SessionController.test.ts`, `auth/__tests__/SignupController.test.ts`, `auth/__tests__/Routes.e2e.test.ts`, `files/__tests__/Routes.e2e.test.ts`, `common/controllers/__tests__/HealthController.test.ts` (seed). |
| Integration | Jest (same runner), Docker-backed Postgres + Minio + Temporal via `make local`. | Used by `Routes.e2e.test.ts` patterns. |
| Browser / E2E | Playwright (`tests/BetaOneLoginFlow.spec.ts`). | One spec — the login flow. |
| Coverage gate | Jest `coverageThreshold` | Set to **5% floor** as a starting fence; raise per area as tests land. |

## 2. Where to invest, in order

This is the priority queue. Each item should land its own ratcheted coverage floor in `jest.config.mjs` when complete.

### Tier 1 — must have before G1 ships

1. **`HealthController`** — done (seed).
2. **`AuthService` + Csrf** — auth is the gate to everything else; bugs are silent breakage.
3. **`EventsIngestController`** (new in G1) — the single highest-leverage controller. Target **>90% line coverage on this controller and its zod schemas** per `event-ingest-spec.md` §7.
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

## 4. Coverage ratchet

The `coverageThreshold` in `jest.config.mjs` starts at 5% (a fence so the number can only go up). Every PR that adds tests should:

1. Land the test.
2. Read the resulting global coverage number from `yarn test --coverage` output.
3. Update `coverageThreshold.global` to **the floor of that number** (never higher than achieved, never lower than current).

This avoids "wishing thinking" thresholds. The floor only ever moves up.

When per-area coverage matters more than global — notably `EventsIngestController` per G1 — add a path-specific threshold:

```js
coverageThreshold: {
  global: { lines: 35, ... },
  'src/domains/events/controllers/EventsIngestController.ts': {
    lines: 90, branches: 85, functions: 90, statements: 90,
  },
}
```

## 5. CI integration

`CI-Local-CICD` should run `yarn test --coverage --ci` and fail the build on coverage regression. This is the only enforcement that makes the ratchet stick.

The Marketplace install E2E (planning.md G3) lives separately — Playwright + Docker, run against a Hub + Marketplace + fixture-app stack. That is **not** in this Jest config; it lives in `tests/` at the repo root.

## 6. Test data

`make seed` produces the John Smith demo dataset. Avoid relying on it in unit tests — they should each provision their own minimal fixtures so they survive seed schema changes. Reach for the seed only in E2E flows that legitimately need a realistic graph.

## 7. Open questions

- **Test containers vs. shared Postgres?** Today integration tests reuse the dev Postgres. As volume grows, per-test containers (via `testcontainers-node`) will scale better. Decide before coverage passes 40%.
- **Snapshot tests for GraphQL schemas?** The `graph` controller's SDL is autogenerated; a snapshot test would catch unintended schema changes. Recommend yes once `graph` has unit coverage.
- **Mutation testing?** Stryker would tell us whether our coverage numbers reflect real behavioral coverage. Worth piloting once we cross 50% global.
