# Sources system audit

> Private & Confidential — Property of Lifescope Inc. Do not distribute.

**Scope.** How CI-Server discovers, authenticates, ingests, parses, dedupes and maps external
data into the `ci.*` schema: `domains/import/`, `domains/etl/`, `domains/ingest/`,
`domains/connections/`, `domains/parsing/`, `domains/files/`, `domains/browser-activity/`,
`domains/bluebubbles/`, `docs/import/`, and the `ci_import.*` / provenance migrations.

**Baseline.** Read against `origin/main` = `7367b26e8` and audit worktree HEAD
`f26f5b68a` ("Search index: stop embedding planned blocks through the pipeline", #2556).
Every `file:line` below was re-read on that tree.

**Gating caveat.** CI in this repo is `workflow_dispatch`-only except `mobile-release.yml`,
`desktop-release.yml` and `benchmark-unit.yml`; `main` has no `required_status_checks` and
`required_approving_review_count: 0`. **An absent red check proves nothing** about any code
in this report. Several defects below are locked in by passing unit tests that assert the
buggy behaviour.

**Confidence labelling.** Section 3 findings each survived an independent adversarial
verification pass against the tree (one further claim was refuted during that pass and is
excluded). Section 4 findings were **not** verified — they are leads with a file and a
hypothesis, and must be re-checked before anyone writes code against them.

---

## 1. Subsystem map

There are **two** ingress pipelines plus three side doors. They converge on **one** identity
contract.

```
(A) ARCHIVE IMPORTER   domains/import/     disk archives  → unpack → parse → media → push → ci.*
(B) CONNECTION ETL     domains/etl/        OAuth APIs     → sync (→ jsonb) → transform     → ci.*
(C) BULK REST PLANE    domains/ingest/     POST /v1/*     → NDJSON batches                 → ci.*
(D) BLUEBUBBLES        domains/bluebubbles/ iMessage API  → in-process parse/media/push    → ci.*
(E) CLOUD FILE INGEST  domains/etl/services/CloudFileIngestService  Drive bytes → re-enters (A)
                                            ↓
                      domains/memory/identity/  (the convergence contract)
```

### 1.1 Archive importer (`domains/import/`, 366 files, ~64k lines)

Four stages, each a row in `ci_import.import_stages` and a pg-boss job:
`unpack → parse → media → push` (`constants.ts IMPORT_STAGE_KINDS`).

- **Queues (5).** `IMPORT_STAGE_QUEUE_BY_KIND` = `import-unpack` / `import-parse` /
  `import-media` / `import-push`; `IMPORT_QUEUE='import-stages'` survives only as a drain for
  pre-split jobs. `IMPORT_STAGE_CONCURRENCY` = 1 / 1 / 2 / 1. `IMPORT_STAGE_WEIGHTS` = 20/35/30/15.
- **One event.** `ImportStageEvent='import.stage'`, payload `{runId, stageId, userId}`.
  Chaining is re-emission: `ImportRunService.advance()` → `enqueueStage()` with an explicit
  `queue:` and `singletonKey: stage.id`.
- **The worker** is `listeners/ImportStageListener.ts`: zod-parse → `getStage` → tenancy check
  → `isFinished` → runner lookup → `beginStage` (atomic claim) → 30s heartbeat → `runner.run` →
  `completeStage` → `advance`. Retry is a deliberate no-op because `beginStage` only moves a
  `queued` stage.
- **Crons** (all `role: 'worker'`): stage sweep `'30 */5 * * * *'` → `resumeInterrupted()`;
  `StagedUploadPurgeCron` `'0 17 * * * *'`; `ImportRetentionCron` `'50 40 6 * * *'`.

**Stages.**
`UnpackStage` (326 lines): DB free-space floor → atomic RENAME acquire → `extractUploadedArchive`
(zip-slip `assertInside`, 2,000,000-entry / 100 GiB caps) → recursive `unpackArchives` with
`quarantine()` → `stripSymlinks`.
`ParseStage` (586 lines): `dataSourcesRecognize` then two filters (`dropGenericWhenSpecialised`,
`dropGenericMailWhenSpecialised` where `email` yields to `gmail`), one `StagedWriter` per source,
`rankDataSources()` into `import_runs.data_sources`, reconciled drop ledger.
`MediaStage` (1255 lines): pass 1 uploads media items (`MEDIA_BATCH=200`, `plimit(8)`, resume
keyed on `metadata.FileId`); pass 2 (`runAttachments`) stores `metadata.MediaAttachments` /
`MediaFilePaths` and stamps `AttachmentFileIds` / `AttachmentContentIds` in one atomic UPDATE.
`PushStage` (2495 lines, largest file in the track): seed counters from the ledger →
`pushEntities()` → batches of 500 ordered by uuidv7 → for each batch, `participantsForMany()`,
`toCanonical` + `destinationsFor`, then iterate
`DESTINATION_ORDER = [product_models, communications, events, content, receipts, things,
observations, browser_activity, position]` (order is load-bearing: events before content so
`ci.content.event_id` links; product_models first so identifier claims win) → `sendGroup()`
batched, degrading to per-row `send()` on any throw → `linkSharedContent()` → `recordOutcomes()`
→ three fail-soft post-push kicks (search-index backfill, graph-edge projection, unfurl sweep).

**Staging + identity (the dedup core).**
`staging/StagedWriter.ts` (660) implements the synchronous `ImportPipeline.push`, buffers to
`DEFAULT_FLUSH_THRESHOLD=500`, serialises flushes on a chain, captures the first error and
rethrows at `settled()`.
`staging/identity.ts` (619) is the pure decision layer: `normalizeHandle`, `isShortCode`,
`resolveEntityType`, `entityIdentityKey`, `stagedNaturalKey(type, handle, name)` — **the type is
part of the key**, so retyping moves the graph coordinate — and `hashItem(item, dataSource,
contentDigest?)`, which **returns `item.id` verbatim when the parser set one** and otherwise
hashes `dataSource + classification + filename + timestamp` (deliberately excluding
`intermediateLocation` so album-replicated photos collapse). That short-circuit is the root of
findings SRC-05 and SRC-06.

**Schema** (`20260810164304_create_ci_import_schema.sql`), 7 tables cascading off `import_runs`:
`import_runs`, `import_stages`, `staged_items`
(UNIQUE `staged_items_run_source_hash_uniq (run_id, data_source, content_hash)`),
`staged_entities` (UNIQUE on `(run_id, identity_key)` and `(run_id, dedupe_key)`),
`staged_relationships` (CHECK `num_nonnulls(entity_id, related_item_id)=1`, two partial uniques),
`entity_mappings`, `staged_sources`.

**Source→schema mapping** lives in `push/canonical.ts` (1994) and `push/inputs.ts` (2329).
`sourceSystemFor(row) = row.dataSource`; `sourceIdFor(row) = row.contentHash` — i.e. **the
parser's `item.id` string becomes the `ci.*` `source_id`**. `KIND_BY_CLASSIFICATION` maps ~40
classifications onto the closed kind taxonomy; `destinationsFor` then branches per kind and
strips `position` from every undated record.

**Parsers**: 75 registered data sources in `datasources/` (~38.7k lines), zero stubs, one API
importer (`bluebubbles.ts`). Shared leaves: `timeline.ts` (the `Item`/`Graph`/`ImportPipeline`
contract), `registry.ts` (582, nested-match collapse, sibling matches kept),
`email_mime.ts` / `email_date.ts` / `email_direction.ts` / `email_thread.ts`,
`human_correspondence.ts` (shared with the **live Gmail/Outlook ETL**), `htmlToText.ts`, `_exif.ts`.

### 1.2 Connection ETL (`domains/etl/`, ~15.8k lines)

`EndpointServiceMap.ts` (275) is a hand-built `{sync, transform}` dispatch table keyed on
**provider-name + endpoint-name strings**: 34 sync functions, 35 transforms across Google,
Microsoft, Facebook, Spotify, Steam, GitHub, Reddit, Signal, Slack. Endpoint names,
`iterationType` and TTLs live in seeded JSONB (`ci.providers.endpoints`).

`listeners/SyncOrchestrator.ts` (728) runs three crons, all gated on `scheduled.connection.sync`
(default **true**): `orchestrateSyncJobs` `'5 * * * * *'` (every minute),
`executeSyncJobs` `'8,38 * * * * *'` (`MAX_SYNC_JOBS_IN_FLIGHT=5`),
`executeTransformJobs` `'15 * * * * *'` (`MAX_TRANSFORM_JOBS_PER_TICK=2`, oldest-first).
`INCREMENTAL_SYNC_INTERVAL_MS=10min`, `STALLED_SYNC_MS=1h`. The DB invariant is
`connection_sync_jobs_live_job_idx`.

`domains/connections/` (5235) holds `ClientFactory` (9 providers), `BaseOAuth2Client`,
`CloudOAuthProxyService`, `ConnectionService`, and tokens encrypted at rest.

### 1.3 Cross-pipeline identity (`domains/memory/identity/`, 967 lines)

`FEDERATED_SYSTEMS = {email, calendar, file}` — in these three namespaces the `source_id`
is an **interchange key** (normalized Message-ID / `iCalUID[#RECURRENCE-ID]` / `sha256:<hex>`),
so the importer and the ETL are expected to land on the same row.
`PLATFORM_SYSTEMS` is a ~100-member allow-list; `SYSTEM_ALIASES` folds `github_events→github`,
`reddit_*→reddit`, `chrome*/brave/edge/arc/opera→chromium`, `x→twitter`, `ics→calendar`.
Constructors: `platformIdentity`, `emailIdentity`, `emailFallbackIdentity`,
`calendarEventIdentity`, `facebookPostIdentity`, `attachmentIdentity` (parent + attachment
**bytes** sha256, never the index), `fileIdentity`, `fallbackId(hash) → 'fallback:<sha>'`.
Migration `20260901175654_cross_pipeline_identity.sql` dropped `source_type` from eight unique
indexes, which are now `(user_id, source_system, source_id)`. `ci.record_sources` is the
multi-provenance ledger. Conformance suite: `import/push/__tests__/crossPipelineIdentity.test.ts`.

### 1.4 Side doors

`domains/ingest/` (2768): `@Controller('v1')` NDJSON/JSON bulk plane, ten record kinds,
`owedStages.ts`, `IngestCoalesceService`.
`domains/bluebubbles/` (1500): 10-minute cron + webhook, `createInProcessRun`, drives
`StagedWriter` / `MediaStage` / `PushStage` directly with no unpack.
`domains/files/`, `domains/parsing/` (document extraction into `ci.file_chunks` via the Summary
sidecar), `domains/browser-activity/`.

### 1.5 Test coverage shape

Import: 15 integration specs, ~90 parser tests + golden snapshots, and unit suites for
`push/`, `stages/`, `staging/`, `telemetry/`, `sources/`, `doctor/`, `controllers/`.
**No test file at all** for `ImportRunService` (1613 lines), `registry.ts` recognition dedup,
`sniff.ts`, `csv.ts`, `json.ts`, `ImportRetentionService`, or `guides.ts` content.
ETL: 31 spec files, but **no test for `EndpointServiceMap`** and no transform test for
Facebook Friends/Photos/Videos/Profile, the four YouTube transforms, most Spotify transforms,
Signal, Slack Messages, or Reddit Posts/Comments/Saved.

---

## 2. Findings at a glance

| ID | Sev | One line | Where | Effort |
|----|-----|----------|-------|--------|
| SRC-01 | P1 | Parser bodies in `Item.content.data` are never persisted — Notion/Evernote/Kindle/Goodreads import title-only | `datasources/notion.ts:192` +3 | half-day |
| SRC-02 | P1 | A revoked OAuth grant never sets `needsReauth`; the connection re-syncs and fails every minute forever | `SyncOrchestrator.ts:572` | half-day |
| SRC-03 | P1 | Gmail ETL hardcodes every message inbound, including the SENT label it explicitly fetches | `TransformGmail.ts:119` | half-day |
| SRC-04 | P1 | Gmail ETL scans only top-level MIME parts; nested-body mail stores the ~200-char snippet | `TransformGmail.ts:277` | half-day |
| SRC-05 | P2 | Message-ID-less mail gets a positional, path-blind id inside the **federated** `email` namespace | `datasources/email.ts:369` | half-day |
| SRC-06 | P2 | Google Maps reviews keyed on the bare parse index; a test asserts the bug | `google_maps_places.ts:296` | 1h |
| SRC-07 | P2 | PushStage's per-row degrade path drops the content→event link, and its claimed recovery is impossible | `PushStage.ts:2300` | half-day |

---

## 3. Confirmed findings

### SRC-01 — [P1] Parser bodies written to `Item.content.data` are never persisted

**Where.** `backend/apps/api/src/domains/import/datasources/notion.ts:192`,
`evernote.ts:290`, `kindle.ts:175`, `goodreads.ts:225`.

**What breaks.** Every Notion page, Evernote note, Kindle clipping and Goodreads review lands
in `ci.content` with `text = NULL` and a title only. The body exists nowhere in `ci.*`.

**Evidence.** `Item.content.data` is a lazy `() => Promise<Buffer>` that **nothing** in the
staging or push path ever calls.

- `StagedWriter.writeItem` (`staging/StagedWriter.ts:351-390`) is the only INSERT into
  `ci_import.staged_items`. Its column list is `run_id, user_id, data_source, classification,
  content_hash, occurred_at, timespan_end, latitude, longitude, filename, media_type,
  original_location, intermediate_location, metadata, content_sha256, size_bytes`. It reads
  `item.content?.filename` and `item.content?.mediaType` — never `.data`. `StagedItemEntity.ts`
  has no text/body column.
- `staging/contentDigest.ts digestFile()` streams a **path off disk**, so it cannot see an
  in-memory buffer; and it only runs when `needsContentDigest(item)`
  (`staging/identity.ts:395-397`), which returns false the moment `item.id` is set — all four
  parsers set one.
- `MediaStage.mediaPredicate()` (`stages/MediaStage.ts:1012-1017`) requires
  `COALESCE(intermediate_location, original_location) IS NOT NULL`. These items set neither, so
  the synthesized buffer is never uploaded and no `metadata.FileId` is ever stamped — nothing
  downstream can re-parse the bytes.
- Push side: `toContentInput` (`push/inputs.ts:306`) is
  `const text = rec.description || str(m.Text);`, and `rec.description` is `descriptionFor(m)`
  (`push/canonical.ts:1536-1548`), a lookup over **only** `Text / Body / Message / Description /
  Notes / Note / Highlight / Comment / Caption`. None of the four parsers writes any of them:
  notion `{Title, Source}`, evernote `{Title, Tags, Updated, Source}`,
  kindle `{'Clip Type', Book, Author, Page, Location}`,
  goodreads `{Title, Author, ratings, ISBN, …}` — the CSV's `My Review` column is read into a
  local and passed only to `Buffer.from(review || title)`.
- Content is the **only** destination for these rows: `destinationsFor` (`canonical.ts:1190-1192`)
  returns `['content']` for `kind === 'note' || 'reading.annotation'`.

**Why it survived.** `chatgpt.ts:433`, `gemini.ts:355`, `claude.ts:543/568` and
`google_keep.ts:272` all *also* stamp their text into metadata, so they work — the four outliers
look identical at a glance. Worse, the unit tests assert the buffer directly
(`notion.test.ts:74` does `await weekly.content.data!()`), so they pass while nothing stores it.

**Kindle is the worst case.** `titleFor`'s `reading.annotation` branch
(`canonical.ts:1455-1462`) builds `book — excerpt` from `str(m.Text) || str(m.Highlight) ||
str(m.Body)`, all absent — so every clipping from one book becomes N rows titled just the book
name, with `text` NULL.

**Fix.**
1. *Immediate*: stamp the body into a key `descriptionFor` already reads —
   `Text: raw` (notion.ts:194), `Text: text` (evernote.ts:291),
   `Highlight: clip.text` (kindle.ts:179), `Text: review || undefined` (goodreads.ts:227).
2. *Structural*: either give `Item.content` a persistence path (a `body_text` column on
   `ci_import.staged_items`, written by `StagedWriter.writeItem` for `text/*` under a size cap
   and read by `toContentInput`), **or** delete `content.data` from the `ImportPipeline`
   contract in `datasources/timeline.ts` so no future parser can believe it is stored.
3. Add a golden assertion that a `note` / `annotation` record reaches `toContentInput` with a
   non-null `text`.

**Effort.** Half a day (option 1 + test); ~2 days for the structural column.

---

### SRC-02 — [P1] A revoked or expired OAuth grant never sets `needsReauth`

**Where.** `backend/apps/api/src/domains/etl/listeners/SyncOrchestrator.ts:572` (the catch),
`:503-519` (the refresh call), `domains/connections/services/ConnectionService.ts:174`
(`findActiveConnections`).

**What breaks.** When a user revokes the app at Google/Facebook/etc., the connection stays
`active: true, needsReauth: false` forever. The orchestrator re-mints a sync job on every tick,
it fails, and the user is told nothing. The UI has a working display for this state that can
never fire.

**Evidence.**

- `needsReauth: true` is written in exactly **four** places in the backend, none of them an
  auth-failure path: `ConnectionsController.ts:311` (`getAccountIdentifier` fails immediately
  after the initial code exchange) and `ProviderKeyResolver.ts:42/67/91` (the user edited their
  own OAuth app keys). There is no token-health cron, no failure counter, no
  `ConnectionHealth` service.
- Nothing classifies provider auth failures. `BaseOAuth2Client.refreshAccessToken` (line 219)
  throws an untyped `new Error('Token refresh failed: …')` on any non-OK token response, so
  `invalid_grant` is indistinguishable from a 503; `CloudOAuthProxyService.refreshAccessToken`
  is identical. Grepping `invalid_grant|invalid_token|401|403|Unauthorized` across
  `domains/etl` + `domains/connections` returns only the Steam OpenID validation and one 403
  branch in `ConnectionsController`.
- The catch at `SyncOrchestrator.ts:572-580` calls only
  `markAsCompleted(…, 'failed', {error})`. `connection.needsReauth` and `connection.active` are
  untouched.
- The loop is live by default: `config/default.json:222` sets
  `"scheduled.connection.sync": true`; `ORCHESTRATE_SYNC_JOBS_CRON = '5 * * * * *'` — **every
  minute**, not every ten. `INCREMENTAL_SYNC_INTERVAL_MS` only gates staleness of the last
  success, which stays permanently satisfied after revocation, so a job is minted every minute
  once none is live.
- Dead UI: `frontend/apps/web/src/components/connect/ConnectedAccountsSection.tsx:168`
  (`reauthCount`), `:183` (`hasReauthNeeded`), `:225/230` (the yellow warning).

**Additional defect found while verifying.** The refresh call at `SyncOrchestrator.ts:503-519`
sits **outside** the `try` that opens at line 538. An `invalid_grant` on refresh therefore
escapes `handleSyncJobExecuteEvent` entirely and never reaches the 572 catch — the job was
already claimed `in_progress` at line 462, so it sits there until the stall sweep fails it an
hour later (`STALLED_SYNC_MS = 1h`). (This is also unverified item U-04; treat it as confirmed.)

**Fix.**
1. Add a typed `AuthRevokedError`, thrown by `BaseOAuth2Client.refreshAccessToken` /
   `request` (and the proxy equivalent) when the token endpoint answers `invalid_grant` /
   `invalid_token`, or the API answers 401/403 on the first call of a job.
2. In the sync-execute catch, and in a new try/catch around the refresh block, catch that type
   and call
   `connectionService.update({userId: connection.userId}, connection.id, {needsReauth: true})`
   **before** `markAsCompleted('failed')`. A transient provider outage must **not** set it.
3. Move the refresh block inside the `try` (or give it its own) so every exit path from the
   handler reaches a terminal job status.

**Effort.** Half a day.

---

### SRC-03 — [P1] Gmail ETL hardcodes every message as inbound

**Where.** `backend/apps/api/src/domains/etl/services/Google/transform/TransformGmail.ts:117-119`,
value used at `:180`.

```ts
// For now, assume all messages are inbound unless we can determine otherwise
const direction = CommunicationDirection.INBOUND; // TODO: Determine based on user's email
```

**What breaks.** 100% of the user's **sent** mail is stored in `ci.communications` with
`direction = 'inbound'`. The sync deliberately fetches it: `SyncGmail.ts:57`
(`labelIds=SENT`, historical) and `:117` (`labelId=SENT`, incremental), then
`const messages = inbox.concat(sent)`. Worse, the historical "inbox" call at `SyncGmail.ts:44`
has **no label filter** at all, so sent mail arrives even before the explicit SENT sweep.

**Evidence that nothing corrects it downstream.** `CommunicationService.create`
(`domains/memory/services/CommunicationService.ts:190`) stores `direction: data.direction`
verbatim. `CommunicationParticipantLinkListener` contains zero references to `direction`. No
migration backfills ETL rows. The Gmail transform test has no direction assertion.

**A live reader consumes the wrong value.** `LifeStatsService.ts:559-578` builds its
counterparty set as `from_entity_id WHERE direction='inbound'` UNION
`unnest(to_entity_ids) WHERE direction='outbound'`, then excludes self entities
(`COALESCE(e.is_self,false)=false`). A sent message mislabelled inbound therefore contributes
its **own owner** as the counterparty, is filtered out as self, and the real recipients are
never counted — every sent email is invisible in "who I talk to", and the outbound column is
structurally 0 for the Gmail lane.

**The correct derivation is already in scope, 29 lines above.** `TransformGmail.ts:90` already
computes `headers = headersFromGmailApi({headers, labelIds})`, and `headersFromGmailApi`
(`import/datasources/human_correspondence.ts:81-104`) rewrites `labelIds:['SENT']` into
`X-Gmail-Labels: 'SENT'`. `emailDirection(headers)`
(`import/datasources/email_direction.ts:86-97`) checks `hasSentLabel` first and returns
`'outbound'`. So a one-line fix is available on a variable already in the function. This rules
out "deliberate design".

**Comparison.** `TransformOutlookMail.ts:403` calls `this.determineDirection(message)`
(defined at `:450-460`, keying on `sentDateTime && !receivedDateTime` — weak, but it derives).
Gmail does not derive at all.

**Scope correction.** The related claim that the owner's own address is promoted to a Person
the user "received email from" is only **conditionally** true.
`PromoteService.resolvePerson` (`:118-126`) short-circuits when `email === user.email`, and
`processParticipants` (`:184`) guards `if (userNode.entityId !== entity.id)`. The spurious
Person and `RECEIVED_EMAIL_FROM` edge appear only when the connected Gmail address differs from
the CI-Server account email (common, but not guaranteed). The `direction` half is unconditional.

**Fix.** Replace the constant with `emailDirection(headers)`. Use `EMAILED` rather than
`RECEIVED_EMAIL_FROM` for the from-participant of an outbound message and skip promoting the
owner's own address. While there, replace `TransformOutlookMail.determineDirection` with the
same owner-address comparison.

**Effort.** Half a day including the direction test the file lacks.

---

### SRC-04 — [P1] Gmail ETL only scans top-level MIME parts

**Where.** `backend/apps/api/src/domains/etl/services/Google/transform/TransformGmail.ts:271-283`;
type at `domains/connections/clients/types.ts:289-312`.

```ts
} else if (message.payload?.parts) {
  const textPart = message.payload.parts.find(
    (p) => p.mimeType === 'text/plain' || p.mimeType === 'text/html',
  );
  if (textPart?.body?.data) body = this.decodeBase64(textPart.body.data);
}
```

**What breaks.** A single non-recursive `.find` over the **first** level of parts. When no
top-level `text/*` leaf exists, `body` stays `''` and `TransformGmail.ts:196`
(`content: messageDetails.body || messageDetails.snippet || ''`) falls through to Gmail's
~200-character snippet — which is also already stored as `preview` at `:199`. The body is
silently truncated to a preview, then poisons search and embeddings.

**The omission is structural, not a slip.** `GmailMessage.payload.parts` in
`connections/clients/types.ts:289-312` is `Array<{ mimeType?; body? }>` — no nested `parts`,
no `filename`, no `partId`. The type makes the recursive walk unwriteable.

**The data is present and simply not walked.** `SyncGmail.ts:151-164` calls
`GET /gmail/v1/users/me/messages/{id}` with no `format` param, i.e. Gmail's default
`format=full` — the whole MIME tree is already sitting in `connection_sync_jobs.data`.

**Affected class (narrower than "every attachment-bearing message").** A plain-text message
with an attachment is `multipart/mixed → [text/plain, application/pdf]` and the `.find`
matches. The failing class is any message whose **top-level** parts contain no direct
`text/plain`/`text/html` leaf: `multipart/mixed`/`multipart/related` wrapping
`multipart/alternative` (rich-text mail with an attachment — the common case),
`multipart/signed` (S/MIME, PGP) and `multipart/report`.

**No self-heal, no coverage.** `grep -rln "payload.parts"` over `backend/apps/api/src` returns
only this file. `__tests__/TransformGmail.test.ts` asserts identity, thread key and the two
drop slugs; every fixture has a headers-only payload with no `parts` at all. The archive lane
does it correctly (`import/datasources/email_mime.ts:26-46` recurses), and both lanes converge
on the same row via the federated `email` + Message-ID identity — so a connection-only user has
nothing to repair from.

**Second, smaller defect in the same branch.** When a `text/html` leaf *is* found at the top
level, raw HTML is stored as `content` with no pass through `import/datasources/htmlToText.ts`.

**Fix.** Add `parts?: GmailPart[]` recursively to the payload type; replace the `.find` with a
depth-first walk preferring the first `text/plain` leaf, falling back to the first `text/html`
leaf run through the shared `htmlToText.ts`. Keep `snippet` as `preview` only, never as
`content`.

**Effort.** Half a day.

---

### SRC-05 — [P2] Message-ID-less mail gets a positional, path-blind id inside the federated `email` namespace

**Where.** `backend/apps/api/src/domains/import/datasources/email.ts:369`.
(Reported twice by independent passes — as an identity-contract violation and as a data-loss
vector. They are the same line and are merged here.)

```ts
id: cleanMsgID ? `email:${cleanMsgID}` : `email:${path.basename(location)}#${index}`,
```

**The chain, verified end to end.**

1. `registerDataSource({name: 'email', …})` (`email.ts:471`) makes this datasource
   `FEDERATED_SYSTEMS.email` (`memory/identity/registry.ts:12-14`), where `source_id` is
   contracted to be a normalized RFC Message-ID.
2. `processEml` (`email.ts:127`) passes index `0` unconditionally, and `walkDir`
   (`:100-114`) recurses — so two Message-ID-less `.eml` files with the same basename in
   different folders both key on `email:<basename>#0`.
3. `hashItem` (`staging/identity.ts:459-461`) early-returns `item.id`, so that string is the
   within-run `content_hash`.
4. `sourceIdFor(row) = row.contentHash` (`push/canonical.ts:177`), and `sourceTriple`
   (`push/inputs.ts:99-104`) launders it through `platformIdentity`, which only canonicalises
   the *system* — so the ad-hoc string reaches `ci.*` unvalidated.
   `push/inputs.ts:1419` overrides the triple **only** when a Message-ID exists.

**Consequences.**
- *Loss.* The two same-basename files collide on
  `staged_items_run_source_hash_uniq (run_id, data_source, content_hash)`
  (`20260810164304_create_ci_import_schema.sql:251`) with `ON CONFLICT DO NOTHING`;
  `StagedWriter.ts:392-451` reads the duplicate back and `recordCollapse` fires
  `drop('collapsed-distinct-path')`. The second message is never staged. Downstream, the same
  key would collide again on `communications_source_identity_uniq (user_id, source_system,
  source_id)` (`20260901175654_cross_pipeline_identity.sql:18-20`).
- *Re-key.* Within an mbox the ordinal is a per-file message index, so inserting or removing a
  message re-keys the whole tail on the next import.
- *Contract violation.* `memory/identity/email.ts:41-42` states the rule explicitly — the
  caller must use `emailFallbackIdentity` (which mints `fallback:<sha256>` under a **platform**
  system) "never an ad-hoc string, keeping id-less mail out of the federated namespace".
  `emailFallbackIdentity` has exactly two callers, `TransformGmail.ts:219` and
  `TransformOutlookMail.ts:441`; `git grep emailFallbackIdentity -- domains/import/` returns
  nothing.
- *Doctor blindness.* `doctor/checks.ts:998-1014` (`identity-fallback-lane-rows`) keys on
  `source_id LIKE 'fallback:%'`, which never matches. `identity-unconverged-in-overlap`
  (`checks.ts:1023+`) filters `WHERE rs.platform IS NOT NULL`, and `ledgerPlatform` returns NULL
  for the generic `email` reader — so these rows are excluded from **both** identity checks.

**The repo already knows the right answer.** `gmail.ts:471-486` solves exactly this with
`gmail:nomid:${sha1(headersRaw + '\0' + dedupBody)}` under platform `gmail`, and its comment
states the reason: "Without it the dedup hash collapses to (dataSource, 'email', mbox basename,
timestamp-second), so distinct emails sharing a second would silently overwrite each other."
And `push/__tests__/crossPipelineIdentity.test.ts:113-117` already asserts the exact invariant
this violates — `expect(input.source_id).not.toMatch(/^email/)` — but only with `recordFor()`'s
default `dataSource: 'gmail'`. Substituting `dataSource: 'email'` fails it today.

**Why P2 and not higher.** Only the *generic* `email` reader is affected, not the high-volume
`gmail` Takeout path. `processRawMessage` drops never-sent drafts before the id is minted
(`email.ts:227-232`), removing the largest id-less population. The collapse is recorded in the
drop ledger, so it is observable. The doctor's own remedy text (`checks.ts:989-992`) says
`email` fallback rows "should be rare".

**Two adjacent items, same root cause.**
- `datasources/calendar.ts:212` — `baseId = uid ? uid : \`ics:${basename}:${sig}\`` against
  `FEDERATED_SYSTEMS.calendar`, contradicting `memory/identity/calendar.ts:118-121`. This is a
  **contract violation only, not a loss vector**: `sig` is a sha256 over
  DTSTART/DTEND/SUMMARY/LOCATION/DESCRIPTION (`calendar.ts:190-197`), so a collision requires
  two byte-identical events, which is plausibly the same event.
- The Message-ID-**bearing** generic-email receipt lane never gets `inputs.ts:1419`'s override,
  so it can land as `(email, 'email:<msgid>')` with the prefix retained — a different key from
  the ETL's `(email, <msgid>)`, i.e. a false non-convergence. Fold into the same fix.

**Fix.**
1. In `email.ts:369`, keep `email:${cleanMsgID}` for the Message-ID case; for the id-less case
   mint through `fallbackId()` from `memory/identity/registry.ts` over a content hash
   (`sha1(rawHeaders + '\0' + bodyText)`), so the row is path- and order-independent **and**
   visible to `identity-fallback-lane-rows`.
2. Extend `push/inputs.ts:1419` so that when `emailIdentity()` returns null and
   `rec.sourceSystem` is federated, the triple is rewritten via `emailFallbackIdentity` rather
   than left as `('email', <ad-hoc>)`; and strip the `email:` prefix when a Message-ID *is*
   present so the receipt lane converges with the ETL.
3. Do the same for `calendar.ts:212` (a UID-less VEVENT keys under a non-federated system).
4. Tests: a `crossPipelineIdentity` case asserting no importer row lands in `email`/`calendar`
   with a non-natural key, and a `datasources/__tests__/email` case for two same-basename `.eml`
   files in one run (today `email.test.ts` has nine tests and none covers cross-file basenames).

**Effort.** Half a day.

---

### SRC-06 — [P2] Google Maps reviews are keyed on the bare parse index

**Where.** `backend/apps/api/src/domains/import/datasources/google_maps_places.ts:296`
(`id: \`gmaps:review:${idx}\``), counter reset at `:209` (`let idx = 0`), comment at `:290-291`.
The same positional fallback exists for cid-less saved places at `:255`.

The in-line comment claims the opposite of the truth: *"reviews carry no place cid in the url
so key on the parse index to keep each review a distinct, idempotent row."* The id carries no
filename, no place, no date and no text.

**Two failure modes.**

1. **Cross-file collision.** `findSupportedFiles` (`:29-52`) recurses to depth 6 and returns
   **every** match, and `registry.ts consider` (`:245-265`) keeps non-nested siblings — so two
   `Reviews.json` in one tree (two Takeouts in one inbox unit, or two accounts) both emit
   `gmaps:review:0,1,2…`. The second file's rows are swallowed by
   `staged_items_run_source_hash_uniq` (`StagedWriter.ts:366`, `ON CONFLICT DO NOTHING`), and
   `recordCollapse` (`:433-450`) does not even flag it — neither item sets
   `intermediateLocation`, so `null === null` returns early and the loss counts only as an
   ordinary `duplicate_in_run` tick.
2. **Re-import re-key.** On a later export where a review was added or deleted, every
   subsequent review shifts index. `ContentService.createManyDetailed` (`:401-411`) uses
   `conflictTarget: '(user_id, source_system, source_id) WHERE source_id IS NOT NULL'` with
   `conflictUpdateColumns: INGEST_REFRESH_COLUMNS.content`, which is **intentionally empty**
   (documented at `:304` as "find-or-return"). So the shifted review hits an existing row and is
   dropped for good, while that row keeps the *old* review's text under the new review's slot.

**The correct pattern is three lines above, and was already applied elsewhere.** The same file
computes `labeledKey = sha1([name, address, lat, lon].join('\0'))` (`:249-252`) for labeled
places. And `google_my_activity.ts:348-368` carries a 20-line docblock describing this exact
mechanism ("an id keyed on position alone … both destination tables are find-or-return, not
upsert-with-overwrite") and replaces the index with `entryFingerprint(ts, title, url)`.
`memory/identity/registry.ts:245-248` states the rule outright: "Never the attachment INDEX —
an index-keyed row would silently fork on a re-import." `reddit.ts:266` and
`google_purchases.ts:183` follow it. `google_maps_places.ts` is the outlier.

**A test locks the bug in.** `__tests__/google_maps_places.test.ts:76-82`:
`it('maps a review with rating, text, place title, and index-based id')` →
`expect(review!.id).toBe('gmaps:review:0')`. Nothing would ever go red.

**Fix.** Key on content, exactly as `pushPlace` keys labeled places:
`id: \`gmaps:review:${sha1([name, address, props.date, rating, text].join('\0'))}\``, dropping
`idx` entirely. Do the same for the `idx` fallback at `:255`. Update the test to assert
stability across a shifted array rather than a literal. (The fixture
`fixtures/google-maps-places/Maps (your places)/Reviews.json` confirms each review carries a
microsecond `date`, `location.name`, `location.address`, rating and text; its `Saved Places.json`
has a `cid` on only 1 of 2 places, so the `:255` path is live too.)

**Effort.** 1 hour.

---

### SRC-07 — [P2] PushStage's per-row degrade path drops the content→event link

**Where.** `backend/apps/api/src/domains/import/stages/PushStage.ts:2300-2303` (per-row `send`),
vs `:2053-2076` (batched `sendMany`); degrade at `:1678-1737`.

**The divergence.** `sendMany`'s content case calls
`this.contents.createManyDetailed(ctx, group.map((plan) => withEvent(toContentInput(plan.record), plan.eventId)))`
and records `plan.contentId` / `plan.contentInserted`; its events case records
`plan.eventId = results[index]?.entity?.id`. The per-row path is
`case 'content': return wroteAnything(await this.contents.createManyDetailed(ctx, [toContentInput(record)]));`
— no `withEvent`, no plan writes — and `case 'events'` (`:2304-2308`) discards the returned
entity id. `grep -n "plan.eventId"` shows `:2072` is the **only** assignment in the file.

`sendGroup` (`:1678-1737`) degrades a whole group of up to 500 rows to `send()` on any throw.
Rows that then succeed keep `failure == null`, so they reach the later content group with
`plan.eventId` undefined.

**Both claimed recoveries are structurally impossible.** The comment at `:2302-2303` says "the
edge sweep covers it". It cannot: `maintenance/services/deterministicEdgeMatrix.ts:190-204`
defines `content.documents_event` with `toIdExpr: 'ct.event_id'` and
`candidateWhere: 'ct.event_id IS NOT NULL'` — a NULL column is zero-candidate. The in-push
fallback cannot cover it either: `linkSharedContent` (`:1620-1638`) filters on
`plan.contentId && plan.eventId && plan.contentInserted === false`, none of which `send()` sets.
The same false claim is repeated in `push/inputs.ts` (~line 350).

**No later repair.** `common/persistence/ingestRefreshColumns.ts:102` is `content: []`, so a
re-import is find-or-return and never revisits `event_id`. The only repair that ever ran,
`db/postgres/migrations/20260819064129_link_content_to_events_by_triple.sql`, is a one-off keyed
on the provenance triple; its header says "Without this migration the existing rows have no
repair path" and names the symptom — blank gallery/list/drawer thumbnails via
`findMediaFilesByEventIds`.

**Real blast radius (both directions).** Narrower than first claimed:
`ContentService.createManyDetailed` still auto-links by provenance triple (`:356-377`,
`:503-577`), and since `DESTINATION_ORDER` writes events before content the event row already
exists — so ordinary triple-sharing rows self-heal even on the degrade path. Worse than first
claimed: `toContentInput` **replaces** `source_id` for URI-keyed rows (`spotify:track:…`) and
for sha256-keyed file rows (`fileIdentity(sha256)`), so for exactly the media/file rows behind
thumbnails the triple diverges from the event's and the auto-link can never fill the gap.

Unrecoverable loss is therefore confined to (a) URI/sha256-keyed rows in a degraded content
group and (b) the missing DOCUMENTS edge for pre-existing content rows in any degraded group.

**Fix.** Thread the plan through the degrade path: change `send()` to take the `RowPlan` (or an
optional `plan` argument), then in `case 'events'` capture `plan.eventId = results[0]?.entity?.id`
and in `case 'content'` call `withEvent(toContentInput(plan.record), plan.eventId)` and set
`plan.contentId` / `plan.contentInserted` — exactly as `sendMany` does. That also makes
`linkSharedContent` reachable for degraded batches. Delete the false comments at
`PushStage.ts:2302-2303` and in `push/inputs.ts`. Add a `stages/__tests__/PushStage.batching`
case forcing the content group to throw and asserting the retried row still carries `event_id`.

**Precedent.** The repo already treats this class of batch-vs-retry divergence as a defect
worth a regression test — "defect F2", `PushStage.batching.test.ts:283-330`, where `send()`
passed a hard-coded null `selfEntityId`. Same remedy.

**Effort.** Half a day.

---

## 4. Unverified findings

> **These were NOT verified.** Each is a file plus a hypothesis produced by a scan, not a
> confirmed defect. Historically roughly half of findings in this shape do not survive a read
> against the current tree (see `memory/import-etl-recurring-defects.md`). **Re-check each
> against `origin/main` before writing any code.** Two pairs in the original list were
> duplicates and are merged below (U-16 absorbed a second `graph_dirty` report; U-21 absorbed a
> second Facebook `Profile` report), so 30 raw items reduce to 28 distinct leads.

### P1 leads

| ID | Lead | Where | Suggested fix |
|----|------|-------|---------------|
| U-01 | Outlook mail sync fetches every message's attachment list, then the transform throws it away | `etl/services/Microsoft/transform/TransformOutlookMail.ts` | Map `message.attachments` into the DTO's `attachments` array (name, contentType, size, isInline, Graph id), mirroring the descriptor shape the import lane writes so one consumer reads both. For bytes, follow `CloudFileIngestService` and fetch `/attachments/{id}/$value` into `FileService`, keyed with `emailAttachmentIdentity(parentIdentity, sha256)`. |
| U-02 | ICS importer discards the TZID on DTSTART/DTEND and reads the wall clock in the appliance's local zone | `import/datasources/calendar.ts` | Give `parseICSDate` a TZID parameter (extract with the `/(?:^\|;)TZID=([^;]+)/` match already used at `:225`) and convert through `utcInstantOfZonedTime` from `@ci/domains/memory`; keep local-time reading only for a genuinely zone-less or unrecognised value. Test: `TZID=America/Los_Angeles:20260120T140000` → 22:00Z regardless of `process.env.TZ`. |
| U-03 | ICS importer never reads ATTENDEE, ORGANIZER or STATUS — imported meetings have no participants and cancelled events land confirmed | `import/datasources/calendar.ts` | Collect repeatable properties into arrays rather than last-wins `map[name] = m[3]` (`:149`); emit one `edges` entry per ATTENDEE/ORGANIZER as a `person` keyed on the `mailto:` handle; carry `STATUS` into metadata and map `CANCELLED` in `toEventInput`. Minimum: stash the raw values in metadata so the data stops being destroyed at parse time. |
| U-04 | Token refresh runs outside `handleSyncJobExecuteEvent`'s try/catch, wedging the job `in_progress` for an hour | `etl/listeners/SyncOrchestrator.ts:503-519` | **Effectively confirmed** while verifying SRC-02 — fold into that fix. Move the block inside the `try` at `:538` or give it its own catch that marks the job failed and returns. |
| U-05 | A connection whose provider issues neither `expires_in` nor a refresh token is never scheduled (GitHub, classic Slack) | `connections/services/ConnectionService.ts:174` | The first `where` branch requires `tokenExpiry: MoreThan(now)`, which a NULL expiry fails. Add a fourth branch (or relax the first) for `active AND accessToken NOT NULL AND refreshToken NULL AND tokenExpiry NULL AND needsReauth = false`. Test the real repository query over all four token shapes rather than mocking the method. |
| U-06 | Disconnect leaves the OAuth grant live at 8 of 9 providers; the endpoint still answers 204 | `connections/clients/BaseOAuth2Client.ts` | Set `revocationEndpoint` on `RedditClient` (`https://www.reddit.com/api/v1/revoke_token`, existing Basic auth) and `SpotifyClient`; override `revoke()` on Facebook/GitHub/Slack for their provider-specific APIs. Where none exists (Microsoft v2), keep `null` but surface it — return `{ tokenRevoked }` from `DELETE /connections/:id` so the UI can tell the user to remove the app at the provider. |
| U-07 | `ProviderKeyResolver` fires `needsReauth` updates through `forEach(async …)`, which this repo documents as a process-exit hazard | `graphql/resolvers/ProviderKeyResolver.ts:42/67/91` | Replace with `for (const c of existingConnections) { await … }` or `await Promise.all(map(...))`. Guard the two `entity!` dereferences with an explicit null check throwing `NotFoundException`. |
| U-08 | `OAuthCallbackPage` returns early before a `useEffect`, so a session lost during the OAuth redirect crashes the page instead of redirecting to login | `frontend/apps/web/src/pages/OAuthCallbackPage/OAuthCallbackPage.tsx` | Compute `const mustLogin = !authLoading && !authToken` before the effects, add `if (mustLogin) return;` as the first line of the effect at `:91`, and render `mustLogin ? <Navigate/> : <LoadingPage/>`. Test with `{authToken: null, loading: false}`. |
| U-09 | `uploadWithDedupInfo` silently discards `captureTickId`/`eventId` on a hash-dedup hit, permanently orphaning repeat CI-Capture screenshots | `files/services/FileService.ts:528` | Pull both out of the destructure and, on the dedup branch before `:549`, stamp them onto the existing row when it has none; send `FileUploadedEvent` on that branch (or add a correlate-only path) so `linkCaptureEvent` runs. Add the two `@Body` params to `BulkFilesController` to match `FilesController`. |
| U-10 | `BrowserActivityInsightListener` can never fire for importer- or bulk-ingested browser activity, so `category`/`productivity_score` stay NULL for the whole imported corpus | `browser-activity/services/BrowserActivityService.ts` | Add a backfill target: either `POST /api/maintenance/browser-activity/insights/backfill` keyset-paging `WHERE category IS NULL AND NOT is_incognito AND NOT contains_sensitive`, or have PushStage's post-push kicks enqueue one insight sweep per run that wrote `browser_activity` rows (mirroring `kickSearchIndexBackfill`). Gate on `BrowserActivityInsightPreferenceService`. |

### P2 leads

| ID | Lead | Where | Suggested fix |
|----|------|-------|---------------|
| U-11 | A staged entity's `type` is decided by whichever parser sees the handle first, but `type` is part of the graph natural key | `import/staging/StagedWriter.ts` | Either add `type` to the within-run key so both sightings stage (letting `merge_candidates` reconcile), or keep the handle-only key and add precedence to `writeEntity`'s conflict path: `DO UPDATE SET type = <more specific>`, with an explicit parser-declared type outranking `resolveEntityType`'s handle-derived default. Document the order in `staging/identity.ts`. |
| U-12 | `retryFailedPush` un-fails staged entities, but the records that named them are already terminal and are never re-sent | `import/services/ImportRunService.ts` | After `resetFailedRows`, also reset the referring items: `UPDATE ci_import.staged_items SET push_status='pending', push_error=NULL, pushed_at=NULL, pushed_ref=NULL WHERE id IN (SELECT r.item_id FROM ci_import.staged_relationships r WHERE r.run_id=$1 AND r.entity_id = ANY($2::uuid[]))`. Safe by the same upsert-on-provenance argument the method already makes. |
| U-13 | `ci.record_sources` never refreshes `record_id`, so a deleted-then-re-created record leaves a ledger row pointing at a dead id | `common/persistence/recordSources.ts` | `ON CONFLICT (…) DO UPDATE SET record_id = EXCLUDED.record_id, connection_id = COALESCE(EXCLUDED.connection_id, …), import_run_id = COALESCE(…)`, leaving `first_seen` alone. The arbiter functionally determines the record, so refreshing stays idempotent. |
| U-14 | Discord attachment content rows are keyed on the attachment's ordinal, which the identity registry explicitly forbids | `import/push/inputs.ts` | Key on the stable URL part: `platformIdentity(rec.sourceSystem, rec.sourceId, 'attachment', new URL(url).pathname)`, falling back to `String(i)` only when the URL will not parse. |
| U-15 | `WizardSource.provenance` has no reader anywhere — OneDrive, Dropbox, Backblaze, Koofr and Synology imports all land as `source_system='generic'` | `import/sources/guides.ts` | Resolve `provenance` for the unit's declared source in `ImportInboxService`/`ImportRunsController`, carry it on the run, and in `ParseStage.writerFor` (`:183`) pass `provenanceFor(name, run) ?? name` as the writer's `dataSource`. Add the five names to `PLATFORM_SYSTEMS` first. If it will not be implemented, delete the field and its five entries. |
| U-16 | `ci_import.staged_relationships.related_item_id` is written with its own unique index but never read — item↔item edges are discarded at push | `import/staging/StagedWriter.ts` | Consume it: after `recordOutcomes`, query `staged_relationships WHERE related_item_id IS NOT NULL AND item_id = ANY(batch)`, map both endpoints through the per-row ids the plans hold, and emit via the same `this.graph.ingest(...)` call `linkSharedContent` uses. Or retire it: drop the column, CHECK and partial index, and make `writeGraph:333` `drop()` such targets so the loss appears in the ledger. |
| U-17 | A digital purchase returns destinations out of `DESTINATION_ORDER`, breaking the invariant the ordering test claims to pin | `import/push/canonical.ts:1083` | `return good === 'content' ? [good, ...receipt] : [...receipt, good]`, or sort by `DESTINATION_ORDER` rank once inside `destinationsFor`. Add a `commerce.purchase` fixture with `metadata: { IsDigital: true, Product: 'Kindle Edition' }` to `destinationOrder.test.ts`. |
| U-18 | The 4,000-char event-description cap is applied to `ci.content.text`, truncating note and message bodies in the searchable column | `import/push/inputs.ts` | Split the concerns: keep `descriptionFor`'s cap for `toEventInput`; in `toContentInput` read an uncapped `bodyTextFor(m)` sharing the key list but without `sliceSafe`. Interacts with SRC-01 — do them together. |
| U-19 | Token-refresh error handling reads the response body twice, replacing the real auth failure with "Body is unusable" | `connections/clients/BaseOAuth2Client.ts` | Use the `exchangeAuthorizationCode` shape: `const raw = await tokenResponse.text()` once, then `try { JSON.parse(raw) } catch { raw }`, wrapped so an unreadable body falls back to a fixed message. **Prerequisite for SRC-02** — you cannot classify `invalid_grant` while the body is being destroyed. |
| U-20 | Two worktrees frozen mid-merge since 2026-08-18 hold a resolution that would delete the Reddit ETL connector and 592 lines of `configuration.ts` | `.claude/worktrees/wf_f69565fb-6a4-3`, `…-6a4-4` | Confirmed present today (`git worktree list`), holding `feat/slack-etl-connector` and `feat/reddit-etl-connector`. In each: `git merge --abort`, then `git worktree remove`, then delete the branch — both are ancestors of `origin/main`, so nothing is lost. Do **not** commit either merge. |
| U-21 | The capture screenshot→event link is one-shot and racy, and the "future repair pass" the migration relies on was never built | `memory/services/FileService.ts` | Add the promised repair: a migration-time backfill in the shape of `20260819064129_link_content_to_events_by_triple.sql`, or a low-frequency `@Cron` running `UPDATE ci.files f SET event_id = e.event_id FROM ci.events e WHERE f.event_id IS NULL AND f.capture_tick_id IS NOT NULL AND e.capture_tick_id = f.capture_tick_id AND e.user_id = f.user_id`, bounded by a recency window. The partial indexes from `20260830042159` already support it. |
| U-22 | Five location parsers emit no `drop()` or `consumed()` at all, so their parse-stage loss ledger is vacuously balanced | `import/datasources/google_location.ts`, `geojson.ts`, `gpx.ts`, `nmea.ts`, `kmlgx.ts` | Add `pipeline.drop?.('outside_timeframe')` / `('position_without_fix')` (both already in `DROP_SLUG_REASONS`) at `google_location.ts:120/125`, `geojson.ts:131/168/190/196`, `gpx.ts:192/272`, and the NMEA/KML equivalents. Where input rows are cheap to count (`list.length`, `doc.features.length`), also call `pipeline.consumed(n)` so `stageSummary.ts`'s reconciliation can actually fail. |

### P3 leads

| ID | Lead | Where | Suggested fix |
|----|------|-------|---------------|
| U-23 | `ContentService.findBySource` still matches `source_type`, unlike the mirror it names — cross-pipeline lookups miss | `memory/services/ContentService.ts` | Drop `sourceType` from the `where` and make `source_type` optional in the parameter type, matching `CommunicationService.findBySource` and `sourceWhereFor` in the same file. |
| U-24 | `ci_import.staged_entities.graph_dirty` and its partial index are written but never read — the dirty sweep they exist for does not exist | `import/staging/StagedWriter.ts:591-593`, `import/stages/PushStage.ts` | Either implement the reader (`pushEntities` selects `push_status='pending' OR graph_dirty`, and `markEntity` clears it) or delete the column, `staged_entities_dirty_idx`, the write and the docstrings that promise the sweep. *(Reported twice; one item.)* |
| U-25 | `WizardSource.signature` (33 entries) has no reader — the documented inbox readiness discriminator for shared `inboxPath`s does not exist | `import/sources/guides.ts` | Implement the matcher next to `declaredSourcesForInboxUnit` in `sources/inboxFolders.ts` (exact / `*.ext` / `prefix-*`, case-insensitive) and have `ImportInboxService`'s scan intersect detected files against each candidate's `signature` before reporting it ready. Test: a `browser/` drop containing only `places.sqlite` reports firefox, not chromium. Otherwise delete the field and its 33 entries. |
| U-26 | Facebook `Profile` transform is registered, injected and dispatchable by name but unreachable — no sync function and no seeded `Profile` endpoint | `etl/services/EndpointServiceMap.ts` | Either seed a `Profile` endpoint in a new `ci.providers` migration plus a matching `syncProfile`, or delete `TransformFacebookProfile`, its import, its constructor parameter and the map entry. Either way add the missing `EndpointServiceMap` test asserting every `transform.<P>.<E>` key has a `sync.<P>.<E>` counterpart — the map has no test today, which is why this survived. *(Reported twice; one item.)* |
| U-27 | `stagesForDestination` / `INGEST_KIND_STAGES` have no production caller — the per-destination owed-stage table is documentation the server never consults | `ingest/owedStages.ts` | Either use it (`BulkIngestController` passes `stagesForDestination(destination)` into `IngestCoalesceService.schedule`, and derive `COALESCE_STAGES` as the union instead of hand-maintaining it) or delete both and keep only `COALESCE_STAGES`. |
| U-28 | All five stalled sources branches are obsolete — three already merged, two superseded by better landed implementations | — | See §5. Nothing to cherry-pick except `fix/data-mapping-open-questions`'s ETL half. |

---

## 5. Stalled-branch salvage

Measured today against `origin/main` = `7367b26e8`.
Conflict counts are from `git merge-tree --write-tree origin/main <branch>`.

| Branch | Verdict | Ahead | Conflicts | Action |
|--------|---------|-------|-----------|--------|
| `fix/data-mapping-open-questions` | **SALVAGE-WITH-CONFLICTS** | 1 commit (`9ab2906bb`, 41 files, +234/−46) | **4**: `etl/services/Reddit/transform/{TransformComments,TransformPosts,TransformSaved}.ts`, `import/datasources/geojson.ts` | Cherry-pick hunk by hunk; do not merge |
| `feat/slack-etl-connector` | **ALREADY-LANDED** | 0 (ancestor of `origin/main`) | — | Remove worktree `wf_f69565fb-6a4-3`, delete branch |
| `feat/reddit-etl-connector` | **ALREADY-LANDED** | 0 (ancestor of `origin/main`) | — | Remove worktree `wf_f69565fb-6a4-4`, delete branch |
| `clau/browser-activity-ai-insights` | **OBSOLETE** | 1 commit (`367b93776`, +589/−2) | 2: `llm/constants.ts`, `llm/index.ts` | Delete branch |
| `clau/link-capture-screenshots` | **OBSOLETE** | 1 commit (`539bf1c0b`, +257/−1) | 3: `common/persistence/index.ts`, `files/controllers/FilesController.ts`, `files/types.ts` | Delete branch; optionally extract one file |

### `fix/data-mapping-open-questions` — what to take

One commit closing open questions from a data-source mapping audit, based on `6f0b68747`
(2026-08-29), so it predates 30+ commits including #2553 ("Fix 32 confirmed findings from the
weekly review").

> **Note on the conflict count.** An earlier pass measured exactly one conflict (geojson.ts).
> `origin/main` has since moved — #2553 landed Reddit provenance work — so the three Reddit
> transforms now conflict as well. Re-measure before starting.

**Already landed independently on `origin/main`; these hunks merge as no-ops — verify and drop:**
`apple_photos` classification `'photo'→'media'`, the `apple_health` SleepAnalysis ternary, the
`FileEntity.external_created_at` `text→timestamptz` change, and the Facebook sync `'picture'`
removal.

**Worth salvaging (ETL half):** GitHub `TransformEvents` `actorRepoMetadata` threaded onto all
13 `create()` calls; Google Calendar using `rawEvent.htmlLink` instead of a synthesized eid URL;
Outlook Calendar stamping `time_source:'ingest'` / `time_precision:'unknown'` when
`start.dateTime` is absent; Reddit Posts/Comments/Saved `metadata.author`
(**conflicting — re-derive against current `TransformPosts/Comments/Saved`**);
Signal Contacts `signal_uuid`; Slack Channels `is_channel`/`is_group`/`dm_user_id`; Slack
Messages `bot_id`; the Spotify Playlists correction dropping two mis-copied recently-played fields.

**Worth salvaging (parser half), each re-triaged against `origin/main` first:**
`applecontacts` `ZBIRTHDAYYEARLESS` month/day-only `birth_date` plus two new `drop()` calls
(`'unreadable_file'`, `'query_failed'`); the `contactlist` `malformed_row` drop; and the
metadata/field additions in `email`, `evernote`, `facebook`, `fitbit`, `flickr`, `flighty`,
`geojson` (**conflicting**), `google_purchases`, `instagram`, `kindle`, `last_fm`, `mastodon`,
`oura`, `roblox`, `spotify`, `strava`, `telegram`, `tiktok`, `timeline`, `youtube` (largest at
+55/−19), plus the `push/inputs.ts`, `StagedWriter`, `identity.ts` and `PositionService` one-liners.

### `clau/browser-activity-ai-insights` — why obsolete

`origin/main` already has `domains/llm/listeners/BrowserActivityInsightListener.ts` (248 lines,
singular "Insight"), the same closed 9-member `BROWSER_ACTIVITY_CATEGORIES`, the same
category→`PRODUCTIVITY_SCORE_BY_CATEGORY` lookup (rather than a second LLM float),
`BROWSER_ACTIVITY_INSIGHT_QUEUE` in `llm/constants.ts:68`, a
`BrowserActivityInsightPreferenceService` the branch lacks,
`BrowserActivityService.findMostRecentCategorized` as its few-shot source, and a test. Merging
would install a **second** listener on the same event writing the same columns on a
near-identically-named queue. The only unique content is the barrel export of
`BROWSER_ACTIVITY_CATEGORIES` from `browser-activity/types.ts` — a one-line move if wanted.

### `clau/link-capture-screenshots` — why obsolete

Superseded by #2467 (`6f0b68747`, "Correlate CI-Capture screenshots with their desktop-activity
event"), which solved the same problem differently and won. `origin/main`'s migration
`20260830042159_add_capture_correlation_to_files_and_events.sql` already adds `ci.files.event_id`
(same FK, same `ON DELETE SET NULL`) **plus** `capture_tick_id` on both `ci.files` and
`ci.events` with partial indexes, and argues explicitly against folding the correlator into the
provenance triple. `FileService` already carries the `eventId`/`captureTickId` passthrough
(`:168-175`) and a `linkEvent()`. Merging would add a duplicate, differently-timestamped
`event_id` migration.

**The one salvageable piece** is `common/persistence/eventTripleLink.ts` (126 lines:
`EventTriple`, `eventTripleKey` with a NUL separator, `resolveEventIdsByTriple` — raw SQL,
index-friendly, NULL-safe, deliberately not going through `EventEntity` to avoid the
memory→files→user require cycle). A generic `resolveEventIdsByTriple` does **not** exist on
main — `ContentService` still keeps a private copy — so extracting it is a legitimate
standalone refactor. Drop everything else on the branch.
