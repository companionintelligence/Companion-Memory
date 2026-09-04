# Sources system — execution plan

> Private & Confidential — Property of Lifescope Inc. Do not distribute.

Companion to [`sources-audit.md`](./sources-audit.md). Finding IDs (`SRC-nn`, `U-nn`) refer to
that document. Baseline `origin/main` = `7367b26e8`.

**Two standing rules for everything below.**

1. **CI proves nothing here.** All workflows except `mobile-release.yml`, `desktop-release.yml`
   and `benchmark-unit.yml` are `workflow_dispatch`-only, and `main` has no required checks.
   Every acceptance check below is a command **you run locally**, not a check you wait for.
   Run one app's tests with `cd backend/apps/api && yarn test <pattern>`.
2. **Several defects are locked in by passing tests.** `google_maps_places.test.ts:76-82` asserts
   the index-based id; `notion.test.ts:74` asserts the body via the loader nothing calls. When a
   fix makes a test fail, check whether the *test* was asserting the bug before "fixing" the code.

**Ordering principle.** Phase 1 items are independent of each other and of everything later —
they can be split across people on day one. Phases 2+ have real dependencies, called out per
phase.

---

## Phase 1 — Silent data loss, no prerequisites (2–3 days, parallelisable)

Four independent changes. None touches a shared abstraction, none needs a migration, none
blocks another. Start here.

### 1.1 Persist parser bodies (SRC-01) — half a day

**Files.**
- `backend/apps/api/src/domains/import/datasources/notion.ts:194` → add `Text: raw`
- `backend/apps/api/src/domains/import/datasources/evernote.ts:291` → add `Text: text`
- `backend/apps/api/src/domains/import/datasources/kindle.ts:179` → add `Highlight: clip.text`
- `backend/apps/api/src/domains/import/datasources/goodreads.ts:227` → add `Text: review || undefined`
- `backend/apps/api/src/domains/import/datasources/__tests__/golden.test.ts` (+ `__snapshots__`)

These four keys are already read by `descriptionFor` (`push/canonical.ts:1536-1548`), so no
push-side change is required. Snapshots will move — review the diff, do not blind-update.

**Acceptance.**
- A new assertion that a `note` and a `reading.annotation` record reach `toContentInput`
  (`push/inputs.ts:306`) with non-null `text`. Put it in `push/__tests__/inputs` so it guards
  the contract rather than one parser.
- Kindle specifically: `titleFor` (`canonical.ts:1455-1462`) must now produce `book — excerpt`,
  not the bare book name. Assert on two clippings from the same book producing distinct titles.
- `cd backend/apps/api && yarn test datasources` green.

### 1.2 Gmail direction + MIME walk (SRC-03, SRC-04) — 1 day

Same file, one reviewer, ship together.

**Files.**
- `backend/apps/api/src/domains/etl/services/Google/transform/TransformGmail.ts:117-119` —
  replace the constant with `emailDirection(headers)`; `headers` is already computed at `:90`
  via `headersFromGmailApi`, and `emailDirection`
  (`import/datasources/email_direction.ts:86-97`) already checks the SENT label first.
- `TransformGmail.ts:128-135` — use `EMAILED` rather than `RECEIVED_EMAIL_FROM` for the
  from-participant of an outbound message.
- `backend/apps/api/src/domains/connections/clients/types.ts:289-312` — make
  `GmailMessage.payload.parts` recursive: `parts?: GmailPart[]`, and add `filename`/`partId`.
- `TransformGmail.ts:271-283` — replace the `.find` with a depth-first walk preferring the
  first `text/plain` leaf, falling back to the first `text/html` leaf passed through
  `import/datasources/htmlToText.ts`.
- `TransformGmail.ts:196` — keep `snippet` as `preview` only; never as `content`.
- `etl/services/Google/transform/__tests__/TransformGmail.test.ts` — has **no** direction and
  **no** body assertion today.

**Acceptance.**
- Fixture with `labelIds: ['SENT']` → the created communication has `direction: 'outbound'`.
- Fixture whose payload is `multipart/mixed → [multipart/alternative → [text/plain, text/html],
  application/pdf]` → `content` is the nested `text/plain` body, **not** the snippet.
- Fixture with a top-level `text/html` leaf → `content` is plain text, not raw markup.
- Sanity on a real corpus if one is available: no `ci.communications` row from the Gmail lane
  should have `LENGTH(content) BETWEEN 150 AND 210 AND content = preview`.

### 1.3 Google Maps review identity (SRC-06) — 1 hour

**Files.**
- `backend/apps/api/src/domains/import/datasources/google_maps_places.ts:296` — replace
  `gmaps:review:${idx}` with `gmaps:review:${sha1([name, address, props.date, rating, text].join('\0'))}`.
- `google_maps_places.ts:255` — same treatment for the cid-less `pushPlace` fallback (reuse the
  existing `labeledKey` shape at `:249-252`).
- `google_maps_places.ts:290-291` — delete the comment that claims the index is idempotent.
- `datasources/__tests__/google_maps_places.test.ts:76-82` — **this test asserts the bug.**
  Rewrite it to assert id *stability* when a review is prepended to the array, not a literal.

**Acceptance.** Parse the fixture, prepend a synthetic review, re-parse: every pre-existing
review keeps its id. Parse the same fixture from two different paths: ids are identical (they
key on content) and the dedup collapse is intentional, not positional.

### 1.4 Location parsers: stop the vacuous ledger (U-22, unverified) — half a day

Cheap, low-risk, and it makes every later change in the importer measurable. **Verify first**
that these `drop()` call sites are genuinely absent.

**Files.** `import/datasources/google_location.ts` (~`:120`, `:125`), `geojson.ts`
(~`:131/168/190/196`), `gpx.ts` (~`:192/272`), `nmea.ts`, `kmlgx.ts`.
Use only slugs already in `telemetry/dropReasons.ts` `DROP_SLUG_REASONS` (`outside_timeframe`,
`position_without_fix`) — the exhaustiveness test greps `datasources/` for `drop?.('…')`
literals and will fail on a new one.

**Acceptance.** `yarn test telemetry` green (the slug-vocabulary test), plus a parse of the
GPX/GeoJSON fixtures where `consumed = produced + dropped` is now a **real** equality rather
than a vacuous one (`telemetry/stageSummary.ts` only checks it when a parser called
`pipeline.consumed()`).

---

## Phase 2 — OAuth failure handling (2 days)

**Dependency.** 2.2 depends on 2.1: you cannot classify `invalid_grant` while the error body is
being destroyed before it is parsed.

### 2.1 Stop double-reading the token-refresh error body (U-19, unverified) — 1 hour

**File.** `backend/apps/api/src/domains/connections/clients/BaseOAuth2Client.ts` (both refresh
blocks). Adopt the `exchangeAuthorizationCode` shape already in the file: read
`const raw = await tokenResponse.text()` once, then `try { JSON.parse(raw) } catch { raw }`,
with an outer fallback message.

**Acceptance.** A unit test where the token endpoint returns
`400 {"error":"invalid_grant"}` and the thrown message contains `invalid_grant` — not
`Body is unusable`.

### 2.2 Classify auth revocation and raise `needsReauth` (SRC-02, absorbs U-04) — 1 day

**Files.**
- `connections/clients/BaseOAuth2Client.ts` — new exported `AuthRevokedError`; throw it from
  `refreshAccessToken` on `invalid_grant`/`invalid_token`, and from `request` on a 401/403.
- `connections/services/CloudOAuthProxyService.ts` — same classification on the proxy path.
- `etl/listeners/SyncOrchestrator.ts:503-519` — **move the refresh block inside the `try` that
  opens at `:538`** (or give it its own try/catch that reaches `markAsCompleted('failed')`).
  Today an `invalid_grant` on refresh escapes the handler entirely and the job sits
  `in_progress` until `STALLED_SYNC_MS` (1 h) sweeps it.
- `etl/listeners/SyncOrchestrator.ts:572-580` — in the catch, on `AuthRevokedError` call
  `connectionService.update({userId: connection.userId}, connection.id, {needsReauth: true})`
  **before** `markAsCompleted('failed')`. A transient 5xx must not set it.

**Acceptance.**
- Unit: a stubbed client throwing `AuthRevokedError` → connection ends with
  `needsReauth: true` and the job ends `failed`. A stubbed 503 → `needsReauth` unchanged.
- Unit: `refreshAccessToken` throwing → the sync job still reaches a terminal status (this is
  the U-04 regression; it fails today).
- Manual: with `needsReauth: true`, `ConnectedAccountsSection.tsx:225` renders its yellow
  warning — a UI path that is currently unreachable.

### 2.3 Schedule non-expiring tokens (U-05, unverified) — 2 hours

**File.** `connections/services/ConnectionService.ts:174` `findActiveConnections`. The first
`where` branch requires `tokenExpiry: MoreThan(new Date())`, which a NULL expiry cannot satisfy;
the second requires a refresh token. A provider issuing neither (GitHub, classic Slack) matches
no branch. **Verify against seeded provider rows before changing** — confirm at least one live
provider actually stores a NULL `tokenExpiry` with a NULL `refreshToken`.

**Acceptance.** A test over the **real** repository query (not a mock of the method) covering
four token shapes: expiring+refreshable, expiring-only, non-expiring, openid. Today the spec
mocks the method away, which is why this is invisible.

---

## Phase 3 — Identity contract convergence (2–3 days)

**Dependency.** Do Phase 1.3 first — it is the same class of bug at one-tenth the size and
establishes the pattern and the test shape.

### 3.1 Route id-less mail and calendar entries out of the federated namespace (SRC-05) — 1 day

**Files.**
- `import/datasources/email.ts:369` — keep `email:${cleanMsgID}` for the Message-ID case; for
  the id-less case mint through `fallbackId()` (`memory/identity/registry.ts`) over
  `sha1(rawHeaders + '\0' + bodyText)`. Copy the working shape from `gmail.ts:471-486`.
- `import/push/inputs.ts:1419` — when `emailIdentity()` returns null and `rec.sourceSystem` is
  federated, rewrite the triple via `emailFallbackIdentity` instead of leaving
  `('email', <ad-hoc>)`. In the same block, strip the `email:` prefix when a Message-ID **is**
  present, so the generic-email receipt lane converges with the ETL's `(email, <msgid>)`.
- `import/datasources/calendar.ts:212` — a UID-less VEVENT keys under a non-federated system
  (e.g. `platformIdentity('ics', sig)` with the `fallback:` marker). Contract violation only,
  no loss — `sig` is already content-derived.

**Acceptance.**
- `push/__tests__/crossPipelineIdentity.test.ts` — extend the existing case at `:113-117`
  (`expect(input.source_id).not.toMatch(/^email/)`) to run with `dataSource: 'email'` as well as
  the default `'gmail'`. It fails today.
- New `datasources/__tests__/email` case: two Message-ID-less `.eml` files with the same
  basename in different folders, one run → two distinct staged rows, zero
  `collapsed-distinct-path` drops.
- `import/doctor` check `identity-fallback-lane-rows` (`doctor/checks.ts:998-1014`) now returns
  these rows instead of being structurally blind to them.

**Migration question to answer before merging.** Existing rows already carry
`email:<basename>#0` ids. Decide explicitly: leave them (the doctor check now names them and a
re-import will not converge them), or add a re-key migration. Do **not** leave this undecided —
see `memory/entity-type-is-part-of-upsert-key.md` for why a key move without a migration mints
duplicates.

### 3.2 Discord attachment ordinals (U-14, unverified) — 2 hours

**File.** `import/push/inputs.ts` — key on `new URL(url).pathname` rather than the ordinal,
falling back to `String(i)` only when the URL will not parse. Same rule as
`memory/identity/registry.ts:245-248` ("Never the attachment INDEX").

**Acceptance.** Re-parse a Discord export with the attachment list reordered: content-row
`source_id`s are unchanged.

---

## Phase 4 — Push-path correctness (1–2 days)

### 4.1 Thread the `RowPlan` through the degrade path (SRC-07) — half a day

**Files.**
- `import/stages/PushStage.ts` — change `send()` (`:2296`+) to accept the `RowPlan` (or an
  optional `plan` argument). In `case 'events'` capture `plan.eventId = results[0]?.entity?.id`;
  in `case 'content'` call `withEvent(toContentInput(plan.record), plan.eventId)` and set
  `plan.contentId` / `plan.contentInserted` — mirroring `sendMany` at `:2053-2076`. This also
  makes `linkSharedContent` (`:1620-1638`) reachable for degraded batches.
- `import/stages/PushStage.ts:2302-2303` and `import/push/inputs.ts` (~`:350`) — delete the
  comments claiming "the edge sweep covers it". It cannot:
  `maintenance/services/deterministicEdgeMatrix.ts:190-204` has
  `candidateWhere: 'ct.event_id IS NOT NULL'`.

**Acceptance.** New case in `stages/__tests__/PushStage.batching.test.ts` (alongside the
existing "defect F2" test at `:283-330`, which is the same class of bug): force the batched
content write to throw, assert the per-row retry still writes `event_id`, and assert
`linkSharedContent` fires for a pre-existing content row in the degraded group.

### 4.2 Destination ordering for digital purchases (U-17, unverified) — 1 hour

**File.** `import/push/canonical.ts:1083` — `return good === 'content' ? [good, ...receipt] :
[...receipt, good]`, or sort by `DESTINATION_ORDER` rank once inside `destinationsFor`.

**Acceptance.** Add a `commerce.purchase` fixture with
`metadata: { IsDigital: true, Product: 'Kindle Edition' }` to
`stages/__tests__/destinationOrder.test.ts` — the digital cell is uncovered today.

### 4.3 Uncap `ci.content.text` (U-18, unverified) — 2 hours

**File.** `import/push/inputs.ts` — `toEventInput` keeps `descriptionFor`'s `DESCRIPTION_MAX`
cap; `toContentInput` reads a new uncapped `bodyTextFor(m)` sharing the key list without
`sliceSafe`.

**Sequencing.** Do this **after** Phase 1.1 — that change is what finally puts real bodies into
those keys, and a 4,000-char cap on a Notion page is the visible symptom.

**Acceptance.** A >4,000-char note fixture round-trips into `toContentInput().text` intact while
`toEventInput().description` stays capped.

---

## Phase 5 — Dead lanes: implement or delete (2–3 days)

Every item here is a schema column, config field or dispatch entry with **no reader**. The
repo's own rule (`memory/built-but-never-wired-inventory.md`) is that these ship in the same PR
as their consumer. Each needs an explicit decision, not a deferral. **All unverified — confirm
the absence of a reader before acting.**

| Item | Decision needed | Files |
|---|---|---|
| U-16 `staged_relationships.related_item_id` | Consume item↔item edges in `PushStage.pushBatch` via `this.graph.ingest`, **or** drop the column + CHECK + partial index and make `writeGraph:333` `drop()` such targets so the loss is ledgered | `import/staging/StagedWriter.ts`, `import/stages/PushStage.ts`, new migration |
| U-24 `staged_entities.graph_dirty` | Widen `pushEntities` to `push_status='pending' OR graph_dirty` and clear it in `markEntity`, **or** delete the column, `staged_entities_dirty_idx`, the write at `StagedWriter.ts:591-593` and the docstrings | `import/staging/StagedWriter.ts`, `import/stages/PushStage.ts`, new migration |
| U-15 `WizardSource.provenance` | Plumb it through `ParseStage.writerFor:183` as the writer's `dataSource` (adding the five names to `PLATFORM_SYSTEMS` **first**), **or** delete the field and its five entries. Until then OneDrive/Dropbox/Backblaze/Koofr/Synology imports land as `generic` | `import/sources/guides.ts`, `import/stages/ParseStage.ts`, `memory/identity/registry.ts` |
| U-25 `WizardSource.signature` (33 entries) | Implement the matcher in `sources/inboxFolders.ts` and intersect it in `ImportInboxService`'s scan, **or** delete the field | `import/sources/guides.ts`, `import/sources/inboxFolders.ts` |
| U-26 Facebook `Profile` transform | Seed the endpoint + add `syncProfile`, **or** delete the transform and its map entry | `etl/services/EndpointServiceMap.ts`, `etl/services/Facebook/` |
| U-27 `stagesForDestination` / `INGEST_KIND_STAGES` | Wire into `BulkIngestController` → `IngestCoalesceService.schedule` and derive `COALESCE_STAGES` as the union, **or** delete both | `ingest/owedStages.ts`, `ingest/controllers/` |

**Mandatory acceptance for the ETL half.** Add the `EndpointServiceMap` test that does not exist
today: for every provider, `Object.keys(map.transform[p])` must be a subset of
`Object.keys(map.sync[p])`. That single test is what would have caught U-26, and it prevents the
next name drift landing as a silent
`markAsCompleted('failed', 'No service function found…')`.

---

## Phase 6 — Remaining leads, batched by area (3–5 days, unverified)

Re-verify each against `origin/main` before starting; expect roughly half not to survive.

- **Attachments and files:** U-01 (Outlook attachments discarded), U-09
  (`uploadWithDedupInfo` drops `captureTickId`/`eventId` on a dedup hit), U-21 (the capture
  screenshot→event repair pass that was promised and never built). One area, one owner.
- **Calendar parsing:** U-02 (TZID discarded — a real timezone bug), U-03 (ATTENDEE/ORGANIZER/
  STATUS never read). Ships naturally with Phase 3.1's calendar half.
- **Staging and retry semantics:** U-11 (staged entity `type` is first-writer-wins on a key that
  includes `type`), U-12 (`retryFailedPush` leaves referring items terminal), U-13
  (`record_sources.record_id` never refreshed).
- **Connections hygiene:** U-06 (disconnect does not revoke at 8 of 9 providers), U-07
  (`forEach(async)` in `ProviderKeyResolver`), U-08 (`OAuthCallbackPage` early return).
- **Backfill:** U-10 (`BrowserActivityInsightListener` unreachable for the imported corpus),
  U-23 (`ContentService.findBySource` still matches `source_type`).

---

## Salvage

### Do now (5 minutes, no code)

```
git worktree remove .claude/worktrees/wf_f69565fb-6a4-3   # feat/slack-etl-connector, frozen mid-merge
git worktree remove .claude/worktrees/wf_f69565fb-6a4-4   # feat/reddit-etl-connector, frozen mid-merge
git branch -D feat/slack-etl-connector feat/reddit-etl-connector \
              clau/browser-activity-ai-insights clau/link-capture-screenshots
```

`git merge --abort` first in each worktree if it refuses. **Do not commit either frozen merge** —
their staged resolution would delete the Reddit ETL connector and 592 lines of
`configuration.ts`. Both branches are ancestors of `origin/main`, so nothing is lost.
Check `git diff --cached origin/main` in each if anyone believes otherwise.

### Abandon

- **`feat/slack-etl-connector`**, **`feat/reddit-etl-connector`** — 0 commits ahead; both are
  ancestors of `origin/main`. Fully landed, including the provider-seed migrations.
- **`clau/browser-activity-ai-insights`** — `origin/main` already has a better
  `BrowserActivityInsightListener` plus a preference service the branch lacks. Merging installs
  a duplicate listener on the same event. The only unique line is a barrel export of
  `BROWSER_ACTIVITY_CATEGORIES`.
- **`clau/link-capture-screenshots`** — superseded by #2467, whose migration is a strict
  superset. Merging adds a duplicate `event_id` migration.

### Cherry-pick

- **`fix/data-mapping-open-questions`** (1 commit, 41 files, +234/−46). **Do not merge — pick
  hunks.** 4 conflicting files as of `7367b26e8`
  (`Reddit/transform/{TransformComments,TransformPosts,TransformSaved}.ts`,
  `import/datasources/geojson.ts`); re-measure with
  `git merge-tree --write-tree origin/main fix/data-mapping-open-questions` before starting.
  Drop the hunks main landed independently (`apple_photos` `'photo'→'media'`, the `apple_health`
  SleepAnalysis ternary, `FileEntity` timestamptz, the Facebook `'picture'` removal). Take the
  ETL metadata additions and the parser hunks listed in the audit's §5, each re-triaged first —
  the branch predates 30+ commits including #2553.
- **`clau/link-capture-screenshots`, one file only:**
  `common/persistence/eventTripleLink.ts` (126 lines). A generic `resolveEventIdsByTriple` does
  not exist on main — `ContentService` keeps a private copy — so extracting it is a legitimate
  standalone refactor. Take the file, drop the migration, the controller passthrough and the
  DTO changes.

---

## Risks

**Identity changes re-key existing rows.** Phase 3.1 and Phase 1.3 both change what
`source_id` a record lands under. `sourceIdFor(row) = row.contentHash` = the parser's
`item.id`, and all eight destination unique indexes are now
`(user_id, source_system, source_id)`. A key move without a migration **mints duplicates** on
the next import rather than converging (`memory/entity-type-is-part-of-upsert-key.md`,
`memory/entity-type-repair-rekey.md`). Every id change in this plan must ship with an explicit,
written decision: re-key migration, or accept the fork and say so in the PR.

**Content tables are find-or-return, not upsert.** `INGEST_REFRESH_COLUMNS.content` is `[]`
(`common/persistence/ingestRefreshColumns.ts:102`) and `ContentService` documents itself as
"find-or-return" (`:304`). A fix that makes a *better* row available does **not** overwrite a
worse row already present. SRC-01 and SRC-04 therefore need a re-import or a backfill to be
visible on existing data — shipping the code is not the same as fixing the corpus.

**Tests that assert the bug.** At minimum `google_maps_places.test.ts:76-82` (index-based id)
and `notion.test.ts:74` (asserts the body through a loader nothing calls). Golden snapshots will
move in Phase 1.1. Read every failing assertion before updating it.

**Gmail ETL changes touch a shipped, live lane.** SRC-03 and SRC-04 alter what
`ci.communications.direction` and `.content` contain for every future Gmail sync.
`LifeStatsService.ts:559-578` reads `direction` today, and two migrations
(`20260819000959`, `20260815220557`) branch on it. Existing mislabelled rows are **not** fixed
by the code change; decide whether a backfill is in scope.

**Half of the unverified list will not survive.** `memory/qa-findings-vs-stale-branch.md`
records a sweep where 62% of re-reported bugs were already fixed, and
`memory/import-etl-recurring-defects.md` sets the standing rule: check an agent-reported
finding against `origin/main` before fixing it. Budget verification time per Phase 5/6 item,
not just implementation time.

**Deleting a dead lane is a schema change.** Phase 5's "delete" options need real migrations
(dropping `related_item_id` also drops a CHECK and a partial unique index). Create every
migration with `yarn workspace @ci/be-api migrate:make <name>` — never hand-write the timestamp
prefix; `bin/check-migration-versions.js` enforces uniqueness and duplicate prefixes have broken
`migrate` for everyone before.

**Nothing gates a merge.** No required status checks, no required approvals. Local test runs
and review are the only gate that exists — treat a green local `yarn test` as the release
criterion, not a CI badge.
