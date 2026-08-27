# CI-Server release QA programme

> Run this before every release. It assumes a clean checkout and nothing else.
> The measured state it was written against is [`baseline-2026-08-26.md`](baseline-2026-08-26.md);
> CI posture and the gates worth turning on are in [`ci-gate-proposal.md`](ci-gate-proposal.md).

## 1. The release gate

A release is **go** when all of the following hold. Anything not met is either fixed or explicitly waived in writing, naming who waived it.

| # | Gate | How it is satisfied |
|---|---|---|
| G1 | Both typecheckers, all four lint lanes, and `lint-canon` are green | §3.1 |
| G2 | Backend, frontend and Python unit suites are green, or every failure is a **classified, waived** pre-existing item | §3.2 |
| G3 | Migrations apply clean from an empty database **and** onto a copy of a populated one | §3.3 |
| G4 | The full-stack E2E suite is green | §3.4 |
| G5 | Every P0 capability in §2 has passed its manual script on **desktop web and phone web** | §4 |
| G6 | Web, iOS, Android and desktop all build, and each has been launched and smoke-tested | §5 |
| G7 | The UI-refactor rubric passes | §6 |
| G8 | No unresolved P0 in §7 | §7 |

**The single most important rule in this document:** a check that did not run is not a check that passed. Eleven of thirteen workflows here are `workflow_dispatch`-only, so an absent GitHub check means *nobody started it*. Record the run, not the absence of a failure.

## 2. Feature inventory and risk ranking

Derived from `git log v<last>..HEAD` and `git diff --name-status`, not from memory. Regenerate per release:

```bash
git log --format='%s' v<last-release>..HEAD | grep -vE '^(Merge |chore|docs|style)' | sort -u
git diff --stat v<last-release>..HEAD -- frontend/apps/web backend/apps/api frontend/apps/ios frontend/apps/android frontend/apps/desktop
```

Rank each capability **P0/P1/P2** by *blast radius × verification gap* — how much breaks if it is wrong, times how likely existing tests are to miss it. The P0 set for the 2026-08-26 window, as a worked example of the shape:

| # | Capability | Surfaces | Flag | Why P0 |
|---|---|---|---|---|
| 1 | **Shell / Power Rail navigation & flag gating** | web, phone, iOS, Android | many | `railDestinations.ts` carries an in-code post-mortem: gating the Self tile on `stats.page` once removed the avatar, theme switcher, Settings **and every logout path**, leaving no way out but clearing storage. Every rail row's flag must equal the flag its destination checks. |
| 2 | **Auth: login, OIDC, session, logout** | all | `auth.portal.*` | OIDC-first login, Portal-brokered service credentials, CSP/wasm logout fix, native cookie-less CSRF. Sessions bind to `ip + user_agent` and rotate on a 30s grace — subtle and easy to break silently. |
| 3 | **Privacy: user-data deletion + OAuth revocation** | web, API | — | CASA V8. Irreversible. Needs its own isolated-database procedure; never run against a database anyone cares about. |
| 4 | **Database migrations** | API | — | Several re-key rows rather than add columns. A re-key that is not idempotent, or that orphans `ci_search` rows, corrupts an installed appliance. |
| 5 | **Memory hub + explorer** (list/map/timeline/gallery/graph, search, filters, drawer) | web, phone | several | The largest single surface in the refactor and the app's core loop. |
| 6 | **Reflections / Self / Profile** | web, phone | `self.page` | Eight `fix(reflections)` + three `fix(self)` commits in three days is a churn signal, not a stability signal. |
| 7 | **Import + ETL** | web, API | `import.page` | Long-running, partially observable, historically the richest source of silent data loss. |
| 8 | **New integrations: BlueBubbles, generic MCP client** | web, API | — | New outbound network surface and new config tables; credentials at rest. |

P1/P2 (verify, but a single failure is not release-blocking on its own): Plan/Calendar/Schedule, Saved Searches + sharing, Asks, Jobs, Stats, Sources/onboarding connect, model routing, maintenance backfills, Forecast/HBPE.

## 3. Automated suites

### 3.1 Static

```bash
yarn workspace @ci/be-api typecheck
yarn workspace @ci/fe-web typecheck
yarn lint
yarn workspace @ci/be-api lint
yarn workspace @ci/fe-web lint
yarn format:check
uv run ruff check . && uv run ruff format --check . && uv run mypy
node scripts/lint-canon.mjs .
```

> Two runners, two flag vocabularies: `@ci/be-api` is **jest** (`--runInBand`, path filters; passing `--run` makes it exit non-zero in a way that reads like a broken suite), `@ci/fe-web` is **vitest** (`vitest run`). A nav or consent-path change usually touches both.

### 3.2 Unit / component

```bash
yarn workspace @ci/be-api test          # jest, ~750 files
yarn workspace @ci/fe-web test          # vitest, ~337 files
uv run pytest                           # hbpe + summary + benchmark
```

**Re-run every failure serially before believing it.** On macOS the SWC transform intermittently dies under jest's worker concurrency with `failed printing to stderr: Resource temporarily unavailable (os error 35)`. That is EAGAIN, not your code. In the baseline this accounted for 3 of 7 failing suites:

```bash
yarn workspace @ci/be-api test --runInBand <the failing paths>
```

The vitest equivalent is a load-induced 5s test timeout; re-run the file alone.

### 3.3 Migrations

```bash
yarn workspace @ci/be-api migrate   # from empty — must apply all, in order
```

Then repeat against a **restored copy of a populated database**. Fresh-seed success proves nothing about a re-key migration: those move a row's natural key, so run each new migration twice and confirm the second is a no-op, and confirm no `ci_search` rows are left pointing at retyped entities.

> Dropping only the `ci` / `ci_search` schemas is **not** a reset — enum types such as `job_status` live outside them and the next `migrate` dies on `type "job_status" already exists`. Use `docker compose … down -v`.

### 3.4 Full-stack E2E

Bring up **four** services — `e2e.yml` currently starts two, which is why it cannot pass (see baseline §4):

```bash
cp .env.default .env
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local \
  up -d database setup-database object-store hbpe-service
yarn workspace @ci/be-api migrate
cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts && cd -
yarn playwright install chromium
yarn e2e --grep-invert @llm
```

- **`object-store` (Minio, :9000)** — the API exits at boot without it (`ECONNREFUSED`), so Playwright's `webServer` never comes up.
- **`hbpe-service` (:8002)** — the seed's `ensure_bootstrap` hard-fails without it, leaving a database with **zero events**. It has no host port mapping in the committed compose files; add one via an override.
- `@llm`-tagged specs need a model and are excluded.

**Authentication in the suite.** Specs that run signed in import `test` from `tests/e2e/fixtures/authenticated.ts`, which signs in inside each test's own context. Do not reintroduce a shared `storageState` file: sessions are bound to `ip + user_agent` **and** rotate on the `/api/authenticate/refresh` the app makes on load, honouring the old token for only `auth.session.refreshGracePeriod` (**30s**). A shared file goes stale partway through a serial suite and every later spec fails on a page assertion while the real cause is an unseen 401. Specs that must start signed *out* (`auth`, `onboarding`) keep importing `@playwright/test`.

> `.env.default` ships `AUTH_DEFAULT_USER_PASSWORD="replace-me-pw-000000"` and the seed uses the same value, so the placeholder is the working password locally. Change both together or neither.

### 3.5 What automation does not cover

Known gaps to cover by hand (§4) until they are closed:

- **Eleven page directories have zero tests:** `CommunicationPage`, `ConceptPage`, `ContentPage`, `EventPage`, `OAuthCallbackPage`, `OpenIDCallbackPage`, `PersonPage`, `PlacePage`, `SharedSearchPage`, `SplashPage`, `SummaryDetailPage`. The two OAuth/OpenID callbacks and `SharedSearchPage` (an unauthenticated public surface) are the ones that matter most.
- **No E2E for** the nav shell itself, Plan, Self/Profile, Reflections, Saved Searches, Asks, Jobs, or Sources.
- **Provider-stubbed tests hide DI faults, and this has bitten twice.** `ActivityRollupService.test.ts` stubs every provider as `{ aggregateHourlyActivity }` and so cannot fail for the duplicate-`FileService` bug that breaks it at runtime (baseline §6.4); `AnswerInferenceListener.test.ts` supplies its own `ollamaService` double and so cannot fail for the barrel-cycle bug that makes `this.ollamaService.chat is not a function` on every cron run (§6.4b). **Both were found by running the app, not by any suite.** When a service's job is *wiring*, at least one test must exercise the real module graph — and the smoke check for it is simply: does the seed run clean, and is the cron log empty?

## 4. Manual scripts

One per P0 capability. Each step names an expected result; record pass/fail and the build tested. Run every script on **desktop web** and **phone web** (≤ 896px); run 1, 2 and 5 additionally on **iOS** and **Android**.

### M1 — Shell, navigation and flag gating (P0)

1. Sign in. **Expect:** land on the app home — `/plan` when `planning.page` is on, `/calendar` when off (`appHomePath`).
2. Visit every Power Rail destination in turn. **Expect:** each navigates, and the row for the current page is the one highlighted.
3. Open the Memory submenu, then the Memory hub tabs. **Expect:** identical labels, order and destinations — both read `MEMORY_HUB_SECTIONS`.
4. Open the Self tile at the foot of the rail. **Expect:** avatar, Settings, theme switcher **and Log out** are all present. Click Log out. **Expect:** signed out, and able to sign back in.
5. Turn `stats.page` **off** and reload. **Expect:** the Stats entry disappears from the Self tile; the tile, theme switcher and Log out all survive. *(This is the exact regression `railDestinations.ts` documents.)*
6. Turn `ask` **off** and reload. **Expect:** the Asks row disappears from under Saved Searches; Saved Searches itself stays. Turn it back on.
7. Narrow to below 896px. **Expect:** the bottom tab bar and mobile top bar replace the rail — one swap, no viewport where both chromes are visible.
8. Open the phone drawer. **Expect:** focus is trapped, Escape closes it, and the page behind is `inert`.
9. Deep-link straight to a hub tab, reload, then press Back. **Expect:** correct tab each time.

### M2 — Auth, OIDC and session (P0)

1. On `/login`, **expect** "Sign in with Companion account" as the primary action and the email form behind "Sign in with email instead".
2. Sign in with email. **Expect:** land on the app home.
3. Reload. **Expect:** still signed in (the app re-mints its JWT from the session cookie).
4. Log out, then press Back. **Expect:** not signed in; a protected route redirects to `/login`.
5. Visit a protected route signed out. **Expect:** redirect to `/login` with the destination preserved in `?redirect=`.
6. On iOS and Android, launch signed out. **Expect:** the **device-connect** screen, not the web `/login`.
7. Sign in with CI-Portal (OIDC) if an issuer is configured. **Expect:** return to the app signed in, once — no double redemption of the one-time code.

### M3 — Privacy: deletion and revocation (P0)

> Run only against a database you are willing to destroy. Take a dump first.

1. Connect a provider, then revoke it. **Expect:** the OAuth token is revoked upstream and the connection disappears.
2. Request user-data deletion. **Expect:** a row lands in the deletion audit table (`20260824051138_create_data_deletion_audit.sql`) and the user's data is gone from `ci.*`.
3. **Expect:** no other user's rows were touched. Verify by counting a second user's rows before and after.

### M4 — Memory hub and explorer (P0)

1. `/memory/events`: list renders seeded results with a total count.
2. Type in the header search box (`placeholder="Search memory…"`). **Expect:** `?search=` appears in the URL and results narrow. Clear it. **Expect:** the param goes away.
3. Apply an entity-type filter. **Expect:** reflected in the URL and survives a reload.
4. Switch list → map → timeline → gallery → graph. **Expect:** each renders; the map shows pins where data has coordinates.
5. Open an entity from a result tile. **Expect:** the shared detail drawer opens; close it and the list state is intact.
6. Right-click (desktop) or long-press (phone) an item. **Expect:** "chat about this" reaches Chat with the right context.
7. Force an API failure (stop the API). **Expect:** every list shows a real error with a retry — **not** a confident empty state. This is what eight `fix(memory)` commits in this window were about.

### M5 — Reflections and Self (P0)

1. `/self`: profile, life details, connections all render; edit a field. **Expect:** autosaves.
2. **Expect:** life details are keyed by `question_key`, not a per-appliance uuid — the same question resolves on a second appliance.
3. Answer a forced-choice question. **Expect:** it must be answered, not merely restated, to advance.
4. Press Skip. **Expect:** it moves to the next question.
5. Check an inferred answer's provenance dot. **Expect:** it names where the inference came from.

### M6 — Import and ETL (P0)

1. Import the vCard fixture (`tests/e2e/fixtures/contacts.vcf`). **Expect:** contacts land in Memory as People with names, not labels.
2. **Expect:** the Inbox/History path heading reflects the real host inbox directory.
3. Re-run the same import. **Expect:** deduplicated, not doubled.

### M7 — BlueBubbles and MCP client (P0)

1. Settings → BlueBubbles: save a config. **Expect:** persisted; credentials not echoed back in plaintext.
2. Settings → MCP servers: add one from the suggested catalog. **Expect:** it connects, tools are listed, and a failure is reported as a failure rather than an empty list.

## 5. Build targets

Install from **inside each app directory**. `ios`, `android` and `desktop` are excluded from the root workspaces (`"!frontend/apps/ios"`, …) because Capacitor, CocoaPods, Gradle and Tauri all walk a real `node_modules` tree that Yarn PnP does not produce. A root install will not materialise them, and "fixing" the exclusion breaks the native builds.

| Target | Procedure | Acceptance |
|---|---|---|
| **Web** | `yarn workspace @ci/fe-web build`, and again with `VITE_DISABLE_PWA=true` | Both succeed; `dist` is produced |
| **Android** | `export JAVA_HOME=$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home`, `export ANDROID_HOME=~/Library/Android/sdk`; then in `frontend/apps/android`: `yarn install && yarn cap sync android && cd android && ./gradlew assembleDebug --no-daemon` | `app-debug.apk` produced; installs on an emulator; launches to device-connect |
| **iOS** | In `frontend/apps/ios`: `yarn install && yarn cap sync ios`; then in `ios/App`: `./Frameworks/fetch-clitertlm-xcframework.sh` and `xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug -sdk iphonesimulator …` | `.app` produced; installs on a simulator; launches to device-connect |
| **Desktop** | In `frontend/apps/desktop`: `yarn install && yarn build` | `.app` + `.dmg` produced (7m33s on Apple Silicon); launches; tray works; splash reaches a healthy stack |

Two standing caveats, both confirmed in the baseline and neither yet fixed:

- **iOS needs two workarounds** or it will not link: `CI_BROWSER_EXTENSION_DIR=<path to a CI-Browser-Extension checkout>` (the pinned release fallback is broken), and an arm64-only build (`ARCHS=arm64 ONLY_ACTIVE_ARCH=YES`, or a specific simulator destination) because `CLiteRTLM.xcframework` ships no x86_64 simulator slice. See baseline §6.2.
- **Desktop pulls images, it does not build them.** Off a non-release commit the bundled tag is `dev-<sha>`, which has never been published — the app builds and then cannot start. Either dispatch `publish.yml` first and test against the real tag, or pass `CI_SERVER_IMAGE_TAG=<published tag>` and record the result as **shell-only**, explicitly not feature coverage. See baseline §6.3.

## 6. UI-refactor rubric

"Does the refactor make sense" needs stated criteria, not taste. All seven must hold.

| # | Criterion | How to check |
|---|---|---|
| R1 | **Single source of truth.** Rail rows, hub tabs, their route matchers and their flags all derive from `railDestinations.ts` / `memoryHubSections.ts`. No page hardcodes its own nav. | `grep` for route literals in page components; M1 step 3 |
| R2 | **Flag/route agreement.** Every rail row's `flag` is the same flag its destination route checks. | Read `railDestinations.ts` against `App.tsx`; the `asks` row (rides `ask`, not `asks.page`) is the worked example of the trap |
| R3 | **Orphaned children get promoted.** Gating a group head off must not take its children with it. | M1 step 6 |
| R4 | **One breakpoint.** Chrome switches only at 896px via `device:` — never `md:`/`lg:`. The 768–896 band once showed both chromes at once. | `grep -rn "md:\|lg:" ` over shell components; M1 step 7; `deviceBreakpoint.node.test.ts` |
| R5 | **No orphan routes.** Every route in `App.tsx` is reachable from the shell, or is deliberately deep-link/redirect-only and says so. | Cross-check `grep -oE 'path="[^"]*"' App.tsx` against the rail, hub and submenus |
| R6 | **Design canon.** No non-phthalo `--primary`, no undefined CI tokens, no hardcoded hex in components. | `node scripts/lint-canon.mjs .` |
| R7 | **Failure is not emptiness.** Every list distinguishes "no data" from "the request failed", and offers a retry. | M4 step 7 |

## 7. Sign-off

| Gate | Result | Who | Date | Notes / waivers |
|---|---|---|---|---|
| G1 static | | | | |
| G2 unit | | | | |
| G3 migrations | | | | |
| G4 E2E | | | | |
| G5 manual P0 | | | | |
| G6 builds | | | | |
| G7 UI rubric | | | | |
| G8 no open P0 | | | | |

**Open P0s must be listed here by name.** As of 2026-08-26 the open set is: the `useAuth`/Android `getLaunchUrl` contradiction (baseline §6.1) and the iOS build lane (§6.2). Both need a decision, not a test edit.

## 8. Re-running this next release

1. Regenerate §2 from the new diff range.
2. Re-run §3 end to end and write a fresh `baseline-<date>.md`. Diff it against the previous one — **the delta is the release risk**.
3. Walk §4 on every surface; §5 on every target; §6 once.
4. Fill in §7. Waive nothing silently.
