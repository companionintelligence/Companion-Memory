# CI-Server release QA programme

> Run this before every release. It assumes a clean checkout and nothing else.
> The measured state it was written against is [`baseline-2026-08-26.md`](baseline-2026-08-26.md),
> partly superseded by [`baseline-2026-08-29.md`](baseline-2026-08-29.md) — where the two
> disagree, the later one wins, and §7 says how to re-derive the open set.
> CI posture and the gates worth turning on are in [`ci-gate-proposal.md`](ci-gate-proposal.md);
> which workflows run on their own is in [`docs/CI.md`](../CI.md), which is the
> only place that table is maintained.
>
> **Counts in this document drift, and several already have.** Numbers that are
> re-derivable from the tree are given with the command that re-derives them
> rather than as a figure to quote — recount at the start of every release pass.
> Corrections applied 2026-09-07: the backend/frontend suite sizes (§3.2), the
> untested page list (§3.5), the `e2e.yml` service count (§3.4), the iOS build
> caveat (§5), the open-P0 set (§7), and the workflow trigger counts, which now
> live only in `docs/CI.md`.

## 1. The release gate

A release is **go** when all of the following hold. Anything not met is either fixed or explicitly waived in writing, naming who waived it.

| # | Gate | How it is satisfied |
|---|---|---|
| G1 | **All three** typecheck lanes, all four lint lanes, and `lint-canon` are green | §3.1 |
| G2 | Backend, frontend and Python unit suites are green, or every failure is a **classified, waived** pre-existing item | §3.2 |
| G3 | Migrations apply clean from an empty database **and** onto a copy of a populated one | §3.3 |
| G4 | The full-stack E2E suite is green | §3.4 |
| G5 | Every P0 capability in §2 has passed its manual script on **desktop web and phone web** | §4 |
| G6 | Web, iOS, Android and desktop all build, and each has been launched and smoke-tested | §5 |
| G7 | The UI-refactor rubric passes | §6 |
| G8 | No unresolved P0 in §7 | §7 |

**The single most important rule in this document:** a check that did not run is not a check that passed. Most workflows here are `workflow_dispatch`-only, so an absent GitHub check means *nobody started it*. Record the run, not the absence of a failure.

Which workflows those are is **not** restated here — that line read "nine of twelve" for two weeks after it stopped being true, which is the exact failure this rule warns about. [`docs/CI.md`](../CI.md) carries the hand-maintained trigger table, per-workflow, with the two `grep` commands that re-derive it from the `on:` blocks. Check it against the tree at the start of every release pass; if it disagrees with the tree, fix the table there rather than adding a fourth copy.

One consequence worth stating plainly, because it is easy to misread now that `pr-gate.yml` runs on every PR: **a green PR covers lint, typecheck, the frontend unit suite and a web-bundle build — and nothing else.** The *backend* and Python suites, E2E, migrations and every native build lane remain dispatch-only. So a green PR page contributes to G1 and to the frontend third of G2, and to nothing else; G3 through G6 are satisfied by a recorded run and never by a green PR page. Do not read the frontend half of G2 as covering the rest of it, and check [`docs/CI.md`](../CI.md)'s `pr-gate.yml` row rather than this sentence — that job list has grown twice in two days.

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
# The eight frontend/packages/* workspaces — the shared layer web, both
# Capacitor shells and the Tauri desktop app all compile into their bundles.
# Nothing typechecked them until pr-gate.yml grew a `packages` lane on
# 2026-09-07. It went in RED — three of the eight failed on
# `Cannot find module '@/lib/utils'` from two @ci/shadcn sources using an alias
# only @ci/shadcn's own tsconfig declares — and was green the same day once
# both imports were made relative (exit 0, measured). `foreach` has no
# --no-bail, so it stops at the FIRST failing workspace: a green run means all
# of them passed, but a red one tells you about exactly one.
yarn workspaces foreach --all run typecheck
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
yarn workspace @ci/be-api test          # jest
yarn workspace @ci/fe-web test          # vitest
uv run pytest                           # hbpe + summary + benchmark
```

**Count the suites, do not quote a count.** These figures moved by ~200 files in under two weeks — this block said `~750` backend / `~337` frontend; on 2026-09-07 the tree held **918** and **381**, and the frontend figure moved by six *during the afternoon this correction was written*. A number in prose here is stale before the next release, so re-derive it and record *that* number in §7, alongside how many actually ran:

```bash
# backend — jest.config.mjs sets roots to src + scripts, testMatch **/*.{spec,test}.ts
find backend/apps/api/src backend/apps/api/scripts \
  -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) | wc -l

# frontend — vitest's two projects both scope `include` to src/**
find frontend/apps/web/src \
  -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) | wc -l
```

A file count is a denominator, not a result: what matters at sign-off is *files collected vs files expected*. A suite that silently collects 40 fewer files than the tree holds is the failure mode this recount exists to catch — a moved `roots` entry or a broken `moduleNameMapper` makes jest report a clean green over a fraction of the suite.

> The native suites are counted the same way and are **not** in `make test` — see the "Native suites" section of [`docs/CI.md`](../CI.md) for the recount recipes and the current figures. Six of the Rust tests are platform-gated (4 macOS-only, 2 Linux-only), so three hosts legitimately report three different totals and that section gives the expected number for each. A difference from those numbers is a lost test, not a `cfg`. They are covered by G6, not G2.

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

```bash
cp .env.default .env
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local \
  up -d database setup-database object-store hbpe-service
yarn workspace @ci/be-api migrate
cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts && cd -
yarn playwright install chromium
yarn e2e --grep-invert @llm
```

- **`object-store` (Minio, :9000)** — the API exits at boot without it (`ECONNREFUSED`), so Playwright's `webServer` never comes up. **Non-negotiable**, and no longer a difference from CI: `e2e.yml` was fixed on 2026-09-06 to start it and to fail the job outright if `http://localhost:9000/minio/health/live` never answers. This used to read "`e2e.yml` currently starts two [services], which is why it cannot pass"; it starts three.
- **`hbpe-service` (:8002)** — **keep it in the command above, but know that CI does not.** The 2026-08-26 baseline §4 measured the seed exiting 1 with `TypeError: fetch failed` from `ensure_bootstrap` and leaving zero events without it; `e2e.yml` now deliberately omits it, with a comment arguing from the source that the seed writes `hbpe.*` rows over its own `DataSource` and never calls the sidecar. Both cannot be right. Until someone re-runs the seed without it and records the exit code and `SELECT count(*) FROM ci.events` — see [`ci-gate-proposal.md`](ci-gate-proposal.md) §3.3 for the procedure — start it locally, because a run that seeds nothing is the more expensive mistake. It has no host port mapping in the committed compose files; add one via an override.
- `@llm`-tagged specs need a model and are excluded.

> `e2e.yml` is not the only E2E lane, and the other one covers what this procedure cannot. `desktop-e2e.yml` drives Playwright against the desktop **appliance** — published images, empty database, no seeded account — i.e. exactly the first-run path a locally built, migrated, seeded stack can never exercise. It is `workflow_dispatch`-only and takes a published image tag, so it can only run after `publish.yml`. Dispatch it against the release tag as part of G6 and record the run in §7.

**Authentication in the suite.** Specs that run signed in import `test` from `tests/e2e/fixtures/authenticated.ts`, which signs in inside each test's own context. Do not reintroduce a shared `storageState` file: sessions are bound to `ip + user_agent` **and** rotate on the `/api/authenticate/refresh` the app makes on load, honouring the old token for only `auth.session.refreshGracePeriod` (**30s**). A shared file goes stale partway through a serial suite and every later spec fails on a page assertion while the real cause is an unseen 401. Specs that must start signed *out* (`auth`, `onboarding`) keep importing `@playwright/test`.

> `.env.default` ships `AUTH_DEFAULT_USER_PASSWORD="replace-me-pw-000000"` and the seed uses the same value, so the placeholder is the working password locally. Change both together or neither.

### 3.5 What automation does not cover

Known gaps to cover by hand (§4) until they are closed:

- **Page directories with zero tests: three of 46, recounted 2026-09-07** — `SharedSearchPage`, `SplashPage`, `SummaryDetailPage`. This list read *eleven* on 2026-08-26; eight of them (`CommunicationPage`, `ConceptPage`, `ContentPage`, `EventPage`, `OAuthCallbackPage`, `OpenIDCallbackPage`, `PersonPage`, `PlacePage`) have since gained a `*.test.tsx`, including both OAuth/OpenID callbacks that the old entry singled out. **`SharedSearchPage` is now the one that matters** — it is the only unauthenticated public surface left with no test at all, so M4 and the manual scripts are its only coverage. Recount rather than trusting this list:

  ```bash
  for d in frontend/apps/web/src/pages/*/; do
    if [ "$(find "$d" -name '*.test.ts*' -o -name '*.spec.ts*' | wc -l)" -eq 0 ]; then basename "$d"; fi
  done
  ```

  A file existing is not coverage — this counts directories, not assertions.
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
2. Sources → Services: the BlueBubbles card. **Expect:** present in the catalogue but not gated behind "Coming soon"; reads "Connected" once step 1's config is `enabled`; opens Settings → BlueBubbles (not a `/providers/:id` OAuth flow) either way.
3. Settings → MCP servers: add one from the suggested catalog. **Expect:** it connects, tools are listed, and a failure is reported as a failure rather than an empty list.

## 5. Build targets

Install from **inside each app directory**. `ios`, `android` and `desktop` are excluded from the root workspaces (`"!frontend/apps/ios"`, …) because Capacitor, CocoaPods, Gradle and Tauri all walk a real `node_modules` tree that Yarn PnP does not produce. A root install will not materialise them, and "fixing" the exclusion breaks the native builds.

| Target | Procedure | Acceptance |
|---|---|---|
| **Web** | `yarn workspace @ci/fe-web build`, and again with `VITE_DISABLE_PWA=true` | Both succeed; `dist` is produced |
| **Android** | `export JAVA_HOME=$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home`, `export ANDROID_HOME=~/Library/Android/sdk`; then in `frontend/apps/android`: `yarn install && yarn cap sync android && cd android && ./gradlew assembleDebug --no-daemon` | `app-debug.apk` produced; installs on an emulator; launches to device-connect |
| **iOS** | In `frontend/apps/ios`: `yarn install && yarn cap sync ios`; then in `ios/App`: `./Frameworks/fetch-clitertlm-xcframework.sh` and `xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug -sdk iphonesimulator …` | `.app` produced; installs on a simulator; launches to device-connect |
| **Desktop** | In `frontend/apps/desktop`: `yarn install && yarn build` | `.app` + `.dmg` produced (7m33s on Apple Silicon); launches; tray works; splash reaches a healthy stack |

Two standing caveats. Re-checked 2026-09-07 — one of the two iOS workarounds has since been landed into the workflow, the other has not and cannot be fixed from this repo:

- **iOS: the arm64 workaround is now in the lane; the extension one is not.** `mobile-build.yml`'s simulator step carries `ARCHS=arm64 ONLY_ACTIVE_ARCH=YES` explicitly, with the reason inline — the generic `iOS Simulator` destination otherwise resolves both slices and `CLiteRTLM.xcframework` ships no x86_64 simulator slice. **A local `xcodebuild` still needs it**, since nothing outside that workflow supplies it. `CI_BROWSER_EXTENSION_DIR=<path to a CI-Browser-Extension checkout>` is still required for any build whose Safari extension must be real: `frontend/apps/ios/scripts/sync-safari-extension.sh`'s own header records why the pinned-release fallback cannot work from here (CI-Browser-Extension is private, this repo holds no cross-repo credential, and no release has ever shipped a `*safari-mobile.zip` asset), so the Debug/simulator lane deliberately warns, drops a `SAFARI_EXTENSION_MISSING.txt` marker into `Resources/`, and exits 0. **Treat a CI simulator `.app` as shell-only** — the marker is the tell — and never ship one. Release/archive builds still fail closed. Unblocking it is an action in the *other* repo. See baseline §6.2.
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

**Open P0s must be listed here by name.** Do not carry a stale set forward — this line named two, and one of them has since closed:

- `useAuth`/Android `getLaunchUrl` (baseline-2026-08-26 §6.1) — **closed.** [`baseline-2026-08-29.md`](baseline-2026-08-29.md) §6.1 records the fix (`useAuth.ts` gates on `isIosPlatform()`) *and* the confirming test run: the named spec does not appear in that pass's failures at all.
- The iOS build lane (§6.2) — **still open, and half of it is not ours.** The arm64 half landed in `mobile-build.yml` (§5). The Safari-extension sourcing half is blocked on a release in `companionintelligence/CI-Browser-Extension`, so it is a decision — ship an iOS build with a stubbed extension, or hold the release — not a test edit.

The open set is whatever the **newest** `baseline-<date>.md` says is open, not what this line says. Re-derive it in step 2 of §8 and rewrite these bullets; two baselines already exist (2026-08-26, 2026-08-29) and the later one supersedes the earlier wherever they disagree.

## 8. Re-running this next release

1. Regenerate §2 from the new diff range.
2. Re-run §3 end to end and write a fresh `baseline-<date>.md`. Diff it against the previous one — **the delta is the release risk**.
3. Walk §4 on every surface; §5 on every target; §6 once.
4. Fill in §7. Waive nothing silently.
