# Cross-Pipeline Identity

**Status:** Implemented (round two) · 2026-09-02 — see §10 for what landed in each round and what remains.
**Scope:** every table carrying the `(source_type, source_system, source_id)` provenance triple — communications, events, content, inventory/objects, receipts, browser activity, product models, object observations — across both ingest pipelines (connection ETL and import-tools) and all future connections.
**Constraint we get to exploit:** the appliance is pre-launch. The database can be wiped and re-imported, so nothing here is bound by historical `source_id` formats or the frozen `SOURCE_TYPE = 'ci-import-tools'` compatibility constant.

---

## 1. Problem

The same real-world datum reachable through two ingest pipelines is stored twice, and nothing ever reconciles the copies.

The concrete case: connect Google **and** upload a Google Takeout archive. Every email lands as two `ci.communications` rows:

| | Gmail connection (ETL) | Takeout import (import-tools) |
|---|---|---|
| `source_type` | `ETL` | `ci-import-tools` |
| `source_system` | `gmail` | `gmail` |
| `source_id` | Gmail API message id | `gmail:<RFC Message-ID>` (or hash fallback) |

The row-level dedup — the partial unique index `(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL`, paired with find-or-return upserts in the memory services — is a **re-ingest idempotency guard**, scoped per pipeline. It answers "have I fetched this before?", not "have I seen this email before?". Since the two pipelines disagree on two of the three columns, the index never fires across them.

This is structural, not Gmail-specific. Every overlap pair duplicates the same way:

- **Google**: Gmail ↔ Takeout mbox, Calendar ↔ Takeout ICS, Drive ↔ Takeout files, YouTube ↔ Takeout history, Photos ↔ Takeout albums, location, purchases, My Activity.
- **Microsoft**: Outlook mail/calendar, OneDrive ↔ the `microsoft_account` export importer.
- **Reddit, GitHub, Spotify, Facebook**: connection ↔ their data-export importers.
- Every future connection, since virtually every platform has a data-export path and we ship importers for them.

And the drift is on **all three columns**, not just `source_type`:

- `source_type` differs by construction (`ETL` vs `ci-import-tools`).
- `source_system` has already diverged organically: the Calendar connection stamps `google_calendar` while the ICS importer stamps `calendar`; the GitHub connection stamps `github_events` for events while the importer stamps `github`; importer names come from the datasource registry (`items.data_source`) while ETL transforms hard-code strings per transform file.
- `source_id` formats are invented per call site (raw API id vs `gmail:`-prefixed Message-ID vs `<parent>:attachment:<i>`).

Downstream, the duplicates are user-visible and model-visible: `ci_search` indexes both rows, the timeline shows both, and HBPE double-counts the behavioral signal.

### What already converges (and must keep working)

- **People.** Both pipelines resolve participants by identifier, not provenance: import via `GraphIngestService` + `ci.entity_identifiers` (emails/phones), ETL via `PromoteService`'s find-by-email. The person graph does not fork today; only the record rows duplicate.
- **Media bytes.** The object store dedupes uploads on content hash (`uploadWithDedupInfo`), so bytes are stored once even when rows duplicate.
- **Objects and places** have post-hoc duplicate-detection/merge services (`ObjectDuplicateService`, `PlaceDuplicateService`) because their keys are genuinely fuzzy.
- **Same-pipeline idempotency.** Re-running a sync or re-uploading the same archive must remain a no-op (the property the 2026-08 provenance-triple work established repo-wide).

---

## 2. Design principle

> **Identity is a property of the datum. Provenance is a property of the arrival.**
> The unique index keys on identity. Provenance is recorded, never keyed on.

Concretely, an email *is* its RFC `Message-ID` regardless of whether it arrived through the Gmail API today or a Takeout mbox next month. The pipeline that happened to deliver it first is bookkeeping.

Three rules implement the principle:

1. **`source_type` leaves the unique index.** The identity index becomes `(user_id, source_system, source_id)`. The `source_type` column stays as plain provenance metadata (which pipeline wrote the row first).
2. **`source_system` and `source_id` are minted by one shared module** — the *identity registry* — and by nothing else. Neither an ETL transform nor an importer datasource ever hard-codes either value again. Convergence holds by construction, not convention.
3. **The compiler enforces rule 2.** The `source_system`/`source_id` fields on the create DTOs change from `string` to a branded type only the identity registry can produce. An ad-hoc id is a type error, in existing code and in every future connection.

---

## 3. The identity registry

**Location:** `backend/apps/api/src/domains/memory/identity/` — the memory domain owns the tables being keyed and is already imported by both the ETL domain and the import domain (no cycle). Re-export through `@ci/domains/memory`.

### 3.1 Branded types

```ts
// identity/types.ts
declare const brand: unique symbol;
export type SourceSystem = string & { readonly [brand]: 'SourceSystem' };
export type SourceId = string & { readonly [brand]: 'SourceId' };
```

`CreateCommunicationDto`, `CreateEventDto`, `CreateContentDto`, `CreateItemDto`, the receipts/observations inputs, and the import pipeline's `CanonicalRecord` all switch their provenance fields to these types. Every current call site breaks at compile time — that is the migration checklist generating itself — and no future call site can bypass the registry.

### 3.2 Two classes of identity

The registry distinguishes keys by their uniqueness scope, and this is the rule every future connection applies:

**Federated kinds** — the datum has a *globally unique* natural key defined by an interchange standard, so the same datum can arrive from *any number of platforms* and still converge. `source_system` is the **kind**, not the platform:

| Kind | `source_system` | `source_id` | Standard |
|---|---|---|---|
| Email | `email` | normalized RFC `Message-ID` | RFC 5322 |
| Calendar event | `calendar` | `iCalUID` (+ `RECURRENCE-ID` suffix for instances) | RFC 5545 |
| File / photo bytes | `file` | `sha256:<content hash>` | — |
| Contact | *(none — stays on `entity_identifiers`)* | | vCard |

This is deliberately stronger than "Gmail converges with Takeout": the same message fetched from Gmail *and* Outlook (both mailboxes cc'd) converges too, as does a calendar invite seen through Google Calendar and an `.ics` file. The platform it came from is recorded in `source_type`-adjacent metadata and in `record_sources` (§5), not in the key.

**Platform kinds** — the id is only unique within one platform's namespace. `source_system` is the **canonical platform name**, one per platform, shared verbatim by the connection and the importer:

| Platform | `source_system` | `source_id` examples |
|---|---|---|
| Reddit | `reddit` | `reddit:<post\|comment\|saved_post\|saved_comment>:<bare id>` (`memory/identity/reddit.ts`) — the bare base-36 id is in both the API (`id`, and prefixed as `name`) and the CSV export; the `reddit:` prefix is the importer's pre-registry staged-id spelling, kept because it is already every imported row's `source_id`. Authored posts and comments are **communications** in both pipelines (plus a content row for media); saved posts and comments are **content only** in both — the API's `created_utc` is the author's time and neither the API nor the export says when the save happened |
| YouTube | `youtube` | video id; watch events `watch:<video id>:<timestamp>` |
| Spotify | `spotify` | track/episode URI; play events `play:<uri>:<ts>` (extended streaming history carries `spotify_track_uri`) |
| GitHub | `github` | commits by sha, stars/repos by full name, events by API event id where stable |
| Facebook | `facebook` | export post/media ids; document the fallback tuple where API and export ids don't align |
| Steam, Signal, Slack, … | one canonical name each | platform-native ids |

The registry is the **single source of truth for the canonical name**. The existing drift (`google_calendar` vs `calendar`, `github_events` vs `github`, `reddit_comments`/`reddit_posts` vs `reddit`) is resolved here once; sub-kind distinctions that today live in `source_system` suffixes move into the `source_id` prefix (e.g. `comment:t1_…`) or the row's own type column, where they belong.

### 3.3 Key builders

Per kind, the registry exports the only constructors of the branded types, e.g.:

```ts
// identity/email.ts
export function emailIdentity(headers: HeaderMap): { system: SourceSystem; id: SourceId } | null;
// Normalization: strip angle brackets and whitespace (hoisted from the mbox
// importer's cleanMsgID); preserve case (Message-ID local parts are case-
// sensitive per RFC). Returns null when the header is absent — the caller
// falls back to kind-specific fallback ids (§3.5), never to an ad-hoc string.
```

`TransformGmail` and `TransformOutlookMail` call it with API headers (the Gmail path already parses them via `headersFromGmailApi` — it currently *discards* `Message-ID`; this is where it stops doing that). The mbox/eml importers call it with MIME headers. One function, one format, provably identical.

Derived records get **derived-id builders** in the same module. Today's attachment ids (`<parent>:attachment:<index>`) are index-based and would *not* converge — API attachment order and MIME part order are not guaranteed to agree. Attachments key on `attachment:<parent id>:<sha256 of bytes>` instead, which also dedupes the same attachment forwarded in multiple messages if we ever want that.

### 3.4 Canonical time

`time` is no longer in any unique index (the dehypertable migration removed it), but the two pipelines still derive different timestamps for the same datum (Gmail API `internalDate` ≈ receipt time; mbox `Date` header = send time), so the surviving row's timestamp would depend on arrival order. Each key builder is paired with a canonical-time rule (email: the `Date` header on both paths, with the importer's existing fallback chain) so the row is arrival-order-independent.

### 3.5 Fallback ids, honestly

When the natural key is missing (Message-ID-less mail, ICS without UID), builders emit an explicitly-marked fallback id (`fallback:<sha256 of normalized stable fields>`). Fallbacks are *not expected to converge across pipelines* — the API body and the MIME body of the same message differ in encoding — and the doc-level position is: accept the residual duplicate rather than pretend a body hash is stable. The conformance suite (§7) tracks which kinds are exact vs fallback-only so the residual risk is enumerated, not discovered.

Known-hard cases, recorded as such:

- **Google Photos**: the API re-encodes and strips EXIF on some paths, so content hash may not match Takeout originals. Fallback: `(filename, EXIF timestamp)` tuple; tier it "derived", expect some residue.
- **Drive/OneDrive vs Takeout files**: Takeout exports carry no Drive file ids → converge on content hash (the `file` federated kind), not platform ids.
- **Facebook/Instagram**: Graph-era ids vs export ids don't reliably align; mostly fallback-tier.

---

## 4. Write-path behavior

Unchanged in shape: the memory services keep their find-or-return upserts, now conflicting on `(user_id, source_system, source_id)`.

**Conflict policy (decided 2026-09-02): the same producer refreshes, another producer fills gaps.** On a bulk-ingest hit the conflict action (`conflictUpdateSetClause` in `common/persistence/bulkUpsert.ts`) compares the arriving `source_type` with the row's. The same producer re-syncing (a corrected parser, a History file copied after Chrome wrote the dwell time) refreshes each listed column with its new value *unless that value is null*; a different producer delivering the same datum keeps the existing value and fills only what is still empty. The null guard is what lets the two rules coexist — a plain `col = EXCLUDED.col` re-sync would erase the other producer's fill-ins. Columns whose type defeats "unless null" carry a merge kind (`INGEST_MERGE_KINDS`): NOT NULL flags OR across producers, object jsonb bags key-merge with the same producer winning shared keys. Tables with an empty refresh list stay find-or-return (first-writer-wins), and the single-row `create` paths the connection ETL uses still are, with one exception: they look the row up and return it, so a live edit does not refresh anything, except the four fields a calendar source owns. `CalendarEventService.createOne` merges a re-delivered status, time, title and place three ways against what that source delivered last time (`ci.events.source_status`, `source_start_time` …, `source_title`, `source_location`; `sourceStatusMerge.ts`, `sourceFieldMerge.ts`, `sourceLocationMerge.ts`), so the source's change lands while a user's edit stands.

**Producer preference (2026-09-02, `INGEST_SCHEMA_VERSION` 6).** Two producers both holding a value for one column was still order-dependent: the first arrival kept it. `INGEST_PRODUCER_PREFERENCE` names, per column, the `source_type` values in order of trust; the conflict action (`conflictUpdateSetClause`) gains one arm between "same producer" and "other producer" — an arriving producer that outranks the row's takes the same-producer treatment (its value wins, null-guarded), a less trusted one still only fills. Unlisted producers rank last and tie, and a tie keeps the arrival-order rule. Flags are excluded (OR is symmetric). The one entry is the measured case: `browser_activity.duration_seconds` prefers the importer (the History file's `visit_duration`) over the extension (`capture`, whose history re-sync sends a 30-second default). Keep the map short — an entry is a claim that one producer's reading of a column is better whatever the row, so it needs a measurement behind it.

**Thread ids (2026-09-02).** `thread_id` is not in the identity index, but the two email pipelines disagreed on it the same way: the Gmail API reports `threadId` in hex, a Takeout mbox carries the same 64-bit number in decimal as `X-GM-THRID`. The registry now owns the format (`identity/email.ts`: `gmailThreadKeyFromApi`, `gmailThreadKeyFromImap`, `emailThreadKey`) — lowercase hex, no leading zeros — and both `TransformGmail` and the mbox datasources (`gmail.ts`, `email.ts`, via `email_thread.ts`, which now re-exports the registry) derive it. A mailbox with no Gmail id keeps the RFC 5322 References-root chain, which is the honest fallback and does not converge with a connection's native thread id. Outlook keeps the Graph `conversationId`; there is no Outlook export importer to pair it with.

---

## 5. `record_sources`: multi-provenance and deletion semantics

With converged rows, "which pipeline(s) evidence this row?" is no longer answerable from the row — and it must be, because deletion keys on it. Today "disconnect Google" or "undo import run N" could plausibly delete by triple; after convergence, a row seen by both the connection and an import must survive either one being removed.

Add one side table:

```sql
CREATE TABLE ci.record_sources (
  user_id        uuid NOT NULL,
  record_table   text NOT NULL,      -- 'communications', 'events', …
  record_id      uuid NOT NULL,
  source_type    text NOT NULL,      -- 'ETL' | 'ci-import-tools' | future pipelines
  source_system  text NOT NULL,      -- as stamped (platform detail for federated kinds)
  source_id      text NOT NULL,      -- the arriving pipeline's raw id (e.g. Gmail API id)
  connection_id  uuid,               -- when ETL
  import_run_id  uuid,               -- when import
  first_seen     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, record_table, source_type, source_system, source_id)
);
```

Appended on every insert *and* every dedup hit. It buys, cheaply:

- **Correct deletion**: disconnect/undo removes its `record_sources` rows and deletes only records left with zero sources.
- **Raw-id lookup**: the Gmail API message id is still findable even though the row keys on Message-ID — useful for incremental-sync bookkeeping and debugging.
- **The acceptance metric**: after importing Takeout and syncing the connection, `record_sources` rows per record ≈ 2 for the overlap window. The import doctor gets a convergence-rate check per source pair.

If deletion-on-disconnect is not yet a behavior we ship, this table can land in the same change anyway — it is append-only and the write is one statement per ingest.

**`platform` (added 2026-09-02, migration `20260902225107`).** Round one stored the identity system in `source_system`, which for a federated kind is the *kind* — a Gmail fetch, an Outlook fetch and a Thunderbird mbox of a Yahoo mailbox all ledger under `email` — so the ledger could not say whether a second producer for the same mailbox existed, and the convergence check counted a Yahoo archive no connection covers as "unconverged". `platform` is the registry-canonical platform the arrival's producer knew: equal to `source_system` for platform kinds; the connection's platform (`gmail`, `outlook_mail`, `google_calendar`, `outlook_calendar`, `onedrive`) or the importer's platform-specific datasource (`gmail` for a Takeout mbox) for federated kinds; NULL when the producer cannot say (the generic `email` mbox/eml reader, the generic `calendar` .ics reader, an external ingest that named none). NULL pairs with nothing. The create DTOs carry it as `source_platform`, `ledgerPlatform()` in the registry decides the stored value, and the row itself never carries it (one row, several arrivals). Rule for a new producer: stamp the platform the *counterpart* stamps, from the registry vocabulary, and never guess — a wrong platform makes two mailboxes look like one, which is the false signal the column exists to remove.

---

## 6. Migration plan

Wipe-friendly ordering (no data preservation required; migrations still append-only per repo policy):

1. **Identity registry module** + branded types, with the conformance fixture suite (§7). Pure addition, no behavior change.
2. **DTO field types switch to the branded types.** The compiler now lists every call site to migrate.
3. **Migrations** (via `yarn workspace @ci/be-api migrate:make`): per table, drop `*_source_triple_uniq`, create `*_source_identity_uniq (user_id, source_system, source_id) WHERE source_id IS NOT NULL`; create `ci.record_sources`. Update TypeORM entities to match.
4. **Migrate call sites** pair by pair, starting where overlap pain is real: email (Gmail + Outlook + mbox/eml), calendar (Google + Outlook + ICS), then files, then platform kinds (Reddit, YouTube, Spotify, GitHub, Facebook).
5. **Wipe, re-import the archives, reconnect the connections.**
6. **Verify** with the doctor convergence check and the §7 suite.

---

## 7. Keeping it true for future connections

The compile-time brand is the hard gate; two soft gates keep the *semantics* right:

**Conformance fixture suite.** Per overlap pair, a fixture holding the same datum in both arrival shapes (Gmail API JSON + mbox text of one message; Google Calendar API JSON + its ICS; Reddit API listing + export CSV row). The test asserts both pipelines produce byte-identical `(source_system, source_id)` and identical canonical `time`. A new connection with an existing importer counterpart **must** add a pair fixture; the suite is the definition of "converges".

**Registry completeness test.** A test enumerates every `source_system` reachable from the ETL transforms and the importer datasource registry and asserts each is a registry-canonical name. Hard-coded strings that bypass the registry (should be impossible past the brand, but e.g. raw SQL) fail here.

**Checklist for adding a connection** (goes in the connection-authoring doc):

1. Does an importer datasource for this platform exist, or plausibly will? (Almost always yes.)
2. Classify each record kind: federated (standard interchange key exists → use the kind's builder) or platform (register the canonical platform name, define native-id builders).
3. Write the key builders in `domains/memory/identity/` *before* the transform; the transform imports them.
4. Define the canonical-time rule per kind.
5. Add the conformance fixture pair if the importer exists; if not, the registry entry is still the contract the future importer must meet.
6. Enumerate the fallback tier honestly: which records of this platform can *not* be exactly keyed, and what residual duplication that implies.

---

## 8. Alternatives considered

- **Post-hoc reconciliation** (an `EmailDuplicateService` à la `ObjectDuplicateService`): match, merge, tombstone, fix downstream references (search index, tags, participants, HBPE-read rows). Strictly more machinery than preventing the duplicate at write time, and only justified where keys are fuzzy. Objects/places keep their merge services precisely because their keys are fuzzy; emails and calendar events are not.
- **Keep `source_type` in the index, teach each pipeline the other's triple**: makes every pipeline pairwise aware of every other — O(n²) coupling, and a third pipeline (e.g. peer federation, CI-Capture backfills) breaks it again. The registry is the O(n) version of the same idea.
- **Normalize ids but keep per-pipeline `source_system`**: fixes nothing — the index still never fires across pipelines.

## 9. Open questions

- Which producer's value wins when BOTH have one is now expressed per column (§4, `INGEST_PRODUCER_PREFERENCE`), with one measured entry. Every other refreshed column still keeps the first arrival; adding an entry needs a measurement.
- Drive's native Google Docs/Sheets/Slides placeholders (`google_drive:<file id>`) have no bytes to hash and cannot converge with a Takeout export of the same document (which is an exported `.docx`, different bytes). Export-then-hash would need the `/export?mimeType=` path CloudFileIngestService does not build yet, and even then the two exports need not be byte-identical.
- Whether `communications.connection_id` should become nullable-and-advisory once `record_sources` exists (it describes one arrival, not the row).
- Peer federation (docs/peer-federation.md): federated-kind keys should make peer-shared records converge too; confirm when that design lands.

## 10. Implementation status (2026-09-01, round one)

**Landed:**

- Identity registry at `backend/apps/api/src/domains/memory/identity/` — branded `SourceSystem`/`SourceId`, canonical system vocabulary + alias map, `platformIdentity` / `canonicalSystem` / `adoptIngestIdentity` / `fallbackId`, email + calendar + file builders.
- Migration `20260901175654_cross_pipeline_identity`: every `*_source_triple_uniq` → `*_source_identity_uniq (user, source_system, source_id)`; `ci.record_sources` created. Entities/decorators updated.
- `bulkInsertIdempotent` matches on the identity pair (source_type no longer matched) and appends the `record_sources` ledger in-transaction (opt-in per service; wired for communications, events, content, objects, receipts, product models, browser activity). The single-row create paths in Communication/Content/CalendarEvent/Receipt services match pair-only too; CommunicationService also ledgers single-row arrivals and dedup hits.
- Email federated kind end-to-end: `TransformGmail` and `TransformOutlookMail` persist the RFC Message-ID and key on `(email, <Message-ID>)` with platform-scoped fallbacks; the importer's `toCommunicationInput` maps any record carrying `metadata.MessageID` to the same pair; `cleanMsgID` normalization hoisted into the registry (one copy).
- Calendar federated kind end-to-end: `TransformGoogleCalendar` / `TransformOutlookCalendar` key on `(calendar, iCalUID[#RECURRENCE-ID])`; the ICS importer's UID keys already had exactly that shape and its datasource name (`calendar`) is the federated system name.
- Every remaining minting site (all ETL transforms, importer push mappers, internal producers) constructs identities through the registry; external input (GraphQL resolvers, `/v1` bulk ingest, browser-extension ingest) goes through `adoptIngestIdentity`.
- Conformance suite (`domains/import/push/__tests__/crossPipelineIdentity.test.ts`, `domains/memory/identity/__tests__/identity.test.ts`) and the registry-completeness scan (`registryCompleteness.test.ts`).

**Deferred, deliberately:**

- **YouTube pair (landed post-verification)**: likes, subscriptions, uploads and playlists mint through shared builders (`identity/youtube.ts`) — the importer extracts the video id from the watch URL and the channel id from subscriptions.csv instead of hashing, converging with the Data API formats; URL-less likes and id-less subscription rows keep per-pipeline hash lanes. Watch/search history stays import-only (the API exposes no watch history).
- **Facebook posts pair (landed post-verification)**: the archive importer now routes posts to /communications (the connection's table — same-table landing is the precondition for any convergence), and both pipelines key posts on the fallback-tier tuple `post:<epoch-seconds>:<16-hex text hash>` via `identity/facebook.ts` — the Meta archive carries no Graph ids, so no exact key exists; the Graph id rides in metadata. Edited posts and story-vs-text link shares stay honest residue. Messenger, likes and media remain single-pipeline or fallback-tier as before.
- **Browser pair (landed 2026-09-02)**: page views, bookmarks and downloads mint through `identity/browser.ts` — `visit:<unix ms>:<url>`, `bookmark:<unix s>:<url>`, `download:<unix ms>:<final url>` under `chromium` (every Chromium-family browser: Chrome, Brave, Edge, Arc, Opera; brand names alias to it) or `firefox`. Three producers converge: the Takeout Chrome importer (`google_chrome.ts`), the History-SQLite importers (`chromium.ts`, `firefox.ts`) and CI-Browser-Extension, which re-implements the format in `src/services/browserActivity.ts` (it cannot import the registry) and stamps the ENGINE's system name from the user agent, not `ci-browser-extension`, for browser-native captures; highlights and scrapes stay under the extension's own name. Time truncates to the coarsest precision every producer reaches exactly (ms; seconds for bookmarks, because `Bookmarks.html` `ADD_DATE` is seconds). Chromium's 1601-epoch microsecond stamps exceed 2^53, so the SQLite importer reads them with `safeIntegers` and the Bookmarks JSON's `date_added` string is parsed as a BigInt — as a JS number a `…999999` visit rounded one millisecond late onto a key Takeout never mints. The extension's live capture now records the browser's own `history.getVisits` instant instead of `Date.now()` at page load, which also stops its own later history sync re-uploading the same visit. Conformance: `identity.test.ts` and the extension's `browserActivity.test.ts` pin the same fixtures; `crossPipelineIdentity.test.ts` covers the importer→`toBrowserActivityInput` path against `adoptIngestIdentity` of the wire pair. The BRAND (Chrome / Brave / Edge / …) is deliberately not on the identity: the History file carries no brand marker, so an importer-side brand would have had to come from the user's filename and a mismatch would silently duplicate. It rides as `properties.browser` instead — the extension detects it at runtime (Client Hints brands, the `navigator.brave` probe; the UA string reports Brave as Chrome), the importers write it when a `History-<brand>` rename or a profile-directory segment says, Takeout is always `chrome` — and the producer-aware merge fills it in from whichever arrival knew. Residue: a live capture on a page the browser does not record (incognito, history off) keys on the observation time and stays its own row.
- **Files pair (landed 2026-09-02, round two)**: a content row that IS its bytes keys on them. `MediaStage` stamps the object store's SHA-256 (`FileSha256`) beside `FileId` on every upload; `toContentInput` promotes it to `(file, sha256:<hash>)` — replacing the per-item staged triple the way a source URI already did, provenance untouched — so the same photo or document from two archives (Google Photos and Apple Photos, a drive walk and an email attachment) lands once. `TransformOneDrive` mints the same pair from the Graph item's `file.hashes.sha256Hash`, which is the connection↔`microsoft_account` pair. A Drive document the connection DOWNLOADS already goes through the import pipeline (`CloudFileIngestService`), so it gets the file identity there. Residue, recorded: Drive-native docs (no bytes; §9), a store that returned no hash (keeps the staged triple), and Google Photos originals the API re-encodes (§3.5). The content→event triple auto-link is forfeited for these rows exactly as for the URI case; the batched push links explicitly and the edge sweep covers the per-row retry.
- **Ledger gaps (closed post-verification)**: every write path now appends `ci.record_sources` — the single-row create paths (events, content, receipts, alongside communications), and the raw-SQL object paths (`ObjectObservationService.writeRows`, `ObjectMintService`, `ObjectPromoteStage`) via widened `RETURNING`. `import_run_id` is populated: PushStage stamps its run id onto `UserServiceContext.importRunId` and the services thread it into every ledger row.
- **Deletion semantics (landed post-verification)**: `DataDeletionService.disconnectConnection` first removes the connection's own ledger arrivals, then deletes connection-scoped communications/content/events rows ONLY where no other arrival remains — a record the import also delivered survives, with its `connection_id` unlinked (reported as `retainedCounts`). Rows that predate the ledger keep the old purge behavior. `ci.record_sources` joined the account-deletion plan.
- **Enrichment-on-hit (landed 2026-09-02)**: the bulk conflict action is now producer-aware (§4) — refresh from the same `source_type`, fill-nulls / flag-OR / bag-merge from another — with `INGEST_SCHEMA_VERSION` bumped to 5 and `INGEST_MERGE_KINDS` classifying the non-scalar columns. Measured cause: after the browser pair converged, the extension's re-sync overwrote the History file's real visit durations with its 30-second default.
- **Producer preference (landed 2026-09-02, round two)**: `INGEST_PRODUCER_PREFERENCE` + the extra conflict arm (§4), version 6; the browser dwell case is order-independent in both directions (integration spec proves it against Postgres).
- **Thread-id convergence (landed 2026-09-02, round two)**: §4; conformance in `identity.test.ts`, `crossPipelineIdentity.test.ts`, `TransformGmail.test.ts` and the importer's `email_thread.test.ts` pin one decimal/hex pair.
- **Attachment identities (landed 2026-09-02, round two)**: the importer's attachment content rows key on `attachment:<parent id>:<bytes sha256>` under the parent's system (`attachmentIdentity`; `emailAttachmentIdentity` is the mail spelling), with the parent being the federated `(email, <Message-ID>)` pair for mail and the staged platform triple otherwise — the same prefix the message itself lands under. The index lane survives only for a store that returned no hash. Discord's link-only attachments (no bytes) stay index-keyed. The connection side (Gmail, Outlook) still catalogues no attachments at all, so there is nothing for these to converge with yet; the format is the contract that work must meet.
- **Import-doctor convergence check (landed 2026-09-02, round two)**: two medium checks. `identity-fallback-lane-rows` counts the residue the marker in §3.5 makes queryable, per table/system; `identity-unconverged-in-overlap` is §5's acceptance metric inverted — for every (user, table, system) two producers delivered, the window of record time both cover (each producer's 5th–95th percentile, because a handful of thread replays with decade-old dates stretched a min/max window enough to count 11,100 archive-only messages on the first post-wipe run), and the records inside it with a single ledger arrival, fallback lane excluded. Zero means the pair converged. First post-wipe reading (2026-09-02, after the trim): the Gmail Takeout ↔ Google connection pair converged 1,022 of 1,384 in-window messages (74%, rising as the Gmail history sync pages), 0 import-only messages had a connection twin by subject and time (no key mismatch), and the remaining ~2,000 email rows were a Thunderbird mbox export of a Yahoo mailbox that no connection covers — they sit inside the window only because every producer of the federated `email` system shares one window. That reading is what motivated `record_sources.platform` (§5): with producers paired per platform, the Yahoo archive (generic `email` reader, platform NULL) drops out of the check entirely and the number left is the Gmail pair alone.

**Post-verification fixes (2026-09-01, after the first real Takeout + connection run):** the mbox datasources' Message-ID lookup was exact-case (`headersMap['Message-ID']`) and silently dropped `Message-Id:` spellings into the never-converging hash lane — both now use the registry's case-insensitive `messageIdFromHeaders`; the Google Calendar sync switched to `singleEvents=false` so it lands series masters + genuine overrides (the ICS representation) instead of one row per occurrence; the ICS importer now normalizes TZID-local `RECURRENCE-ID` values to the UTC-basic suffix via the registry's `normalizeIcsRecurrenceId` (floating times and unrecognized TZIDs stay local — measured residue was 42 override rows, all TZID-local); Facebook Messenger's drifted `source_type: 'import'` now aliases the pipeline constant `'ci-import-tools'`.

**Post-wipe checklist** (unchanged from §6): wipe, `make dev` (migrations apply), re-import archives, reconnect connections, then run `ci doctor --check identity-unconverged-in-overlap --check identity-fallback-lane-rows` — the first should read zero or a small stable residue, the second only the populations §3.5 names. **Still to do as of 2026-09-02**: the wipe itself has not been run; every row written before 2026-09-01 carries the old triples and is outside both checks.
