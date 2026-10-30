# Mobile local search — plan

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Status: 2026-10-22, branch `mobile-local-search`. Phases 0, 0.5 and 1 are
committed (a785c54c4, 8319711c3). The SQLCipher soft-heap fix is staged. **The
remaining work is re-planned in [Revision 2026-10-21](#revision-2026-10-21-one-device-record-per-entity)
below, which replaces the P2–P4 rows of the original phase table.** Of that
revision, **U1–U7 are done and uncommitted** — see the status sections below
(U6's iOS half is written but uncompiled). U7 found and fixed one blocker:
a cold start with the appliance down signed the phone out (see "U7 status").

## What landed (2026-10-19)

- **P0 — PowerSync in `make dev`.** Opt-in by `POWERSYNC_URL` in `.env`: its own
  compose profile, loopback port allocated like every other service, the api
  handed the stack's real port, the Caddy CSP widened, `yarn android` tunnels
  the port. `infrastructure/powersync/README.md` § "Running it under make dev".
- **P0.5 — the native replica is encrypted.** `EncryptedCapacitorSQLiteAdapter`
  (`api/powersync/nativeDatabase.ts`) opens the file through the SQLite
  plugin's SQLCipher mode; a plaintext replica is converted in place on first
  open; both `capacitor.config.ts` enable the plugin's encryption. The
  IndexedDB placeholder is never connected on a phone any more. A drift test
  pins the vendored adapter the copy was taken from. Security docs § 2.3a.
- **P1 — the projection, the sync, the index, the fallback.**
  `ci_search.mobile_search_documents` (migration 20261019212935) written by the one shared
  statement in `VectorService` and the pipeline's vector stages; vector stage
  versions bumped so existing corpora re-run; the backfill route also counts a
  missing document; synced with no window into a PowerSync raw table (since
  2026-10-20; design § 2) with an external-content `mobile_search_documents_fts`
  built on the device (`api/powersync/searchIndex.ts`); `useSearchService`
  answers from `localSearch.ts` when the connection chip says the appliance is
  unreachable or a request fails on the network, with a "From this phone"
  caption; the connection chip now resolves `cached`; Settings copy updated.

**Decisions taken:** names of people and places are on the device (the file is
encrypted, see P0.5); all history for documents; automatic fallback with a
caption. **2026-10-20: the desktop browser syncs nothing.** Its PowerSync
database is plaintext IndexedDB, and with the search documents in the sync set
that was a full offline copy of names, subjects, snippets and people's contact
details in every browser profile that had opened the app. `PowerSyncProvider`
now connects only the SQLCipher replica and wipes any browser copy on load;
offline search is a phone feature, and a browser falls back to nothing.

**Known gaps:** on an existing install the bulk of the documents arrive only
when the next import ends — that is the one thing that requests the pipeline
index sweep the bumped vector stages wait for (a `POST
/maintenance/search-index/sweep` that requests one on demand would be the
natural follow-up); concepts, products and receipts come from the admin
backfill route; notes, threads, tasks and places get a document only when next
written (no pipeline stage, no backfill lane — a few hundred rows); the
explorer page (`/memory`) is still online-only, so the "Search all of Memory
for…" row goes nowhere offline (P3); the on-device model's tool still calls the
appliance (P2); `OrphanCleanupService.plan.integration.test.ts` fails on a dev
database with 226k event embeddings before and after this change (the planner
hash-joins, the test expects a per-row probe).

## Revision 2026-10-21: one device record per entity

**Draft for review. Supersedes the P2–P4 rows of the [Phases](#phases) table
and design § 3's per-type offline pages.**

### Decisions (Kyle, 2026-10-21)

1. **One record shape for every searchable type.** The phone keeps one row
   per entity in `mobile_search_documents`: the search text it has today plus
   a small set of per-type display fields. Search, the offline Memory list,
   the offline detail page and the on-device model's tool all read that one
   table. The original split, with full rows for a few types (events, files,
   threads) and search entries for everything else, is dropped.
2. **Notes stay a separate, writable synced table.** A note is something a
   user writes in this app and may well add to or edit offline. Nobody edits
   Memory's record of a text message they sent. Notes keep their own table,
   the PowerSync upload path in `connector.ts`, and also get a search entry
   like every other type.
3. **P2 includes iOS,** written in this pass and marked uncompiled until it is
   built and run on a Mac.

### Why the split can go

Nothing on the device reads the full-row tables (checked 2026-10-21). Outside
`api/powersync/` the only PowerSync consumers are `useSearchService`, which
reads `mobile_search_documents` and `tags` through `localSearch.ts`, and
`WorkingSetSection`, which reports the file size and offers a clear button.
`events`, `entities`, `files`, `threads` and `messages` are synced and never
queried. The notes upload path exists, but nothing writes notes locally yet:
`NotePage` reads and writes through Apollo.

Those unread tables are most of the replica. On a production phone, where
`SyncWindowSweepCron` holds events to 30 days, they are about 0.4 GB of an
estimated 0.85 GB. On the dev phone, where the sweep has never run, they are
about 1.2 GB of 1.6 GB.

The search entries already carry nearly the whole text. Only 0.7% of
communications and 3 of 132,599 content rows exceed the 1 KB `body` (Kyle's
corpus; median message 38 bytes). What a full row would add is metadata:
direction, conversation, participants, an event's end time and place. That
metadata is what the new display fields carry.

### The record

Two new columns on `ci_search.mobile_search_documents`, mirrored on the
device's raw table:

| column | type | purpose |
|---|---|---|
| `related_id` | uuid, nullable | the row it belongs with: a message's conversation, a sub-event's parent, a file's parent, a task's parent, a place's parent place. Indexed on the device so the detail page can list siblings |
| `detail` | jsonb (text on the device) | the per-type display fields below. JSON rather than typed columns because nothing filters or sorts on them, and a new field then needs no migration and no device DDL change. Capped at 1 KB, with the participants list cut short first and marked `"participants_truncated": true`. Participants run 144 bytes on average, 730 at p99 and 1,880 at most (2026-10-21), so 512 would cut off group messages |

Plus `detail_version` (smallint, server-only, not synced) for the backfill
below.

**Per-type fields** (column names verified against the live schema
2026-10-21). Every type already has `title`, `body` and `occurred_at`:

| type | `detail` | `related_id` |
|---|---|---|
| communication | `communication_type`, `direction`, `participants` (from `participants_metadata`: `from`, `to`, names or numbers as recorded) | a uuid derived from `thread_id`. See [Conversation key](#conversation-key) |
| event | `end_time`, `is_all_day`, `location_name`, `category`, `event_type`, `status` | `parent_event_id` |
| content | `type`, `mimetype`, `source_url` | `event_id` |
| file | `content_type`, `size`, `width`, `height` | `parent_id` |
| person | `first_name`, `last_name`, `is_self` | — |
| place | `place_kind` | `parent_place_id` |
| receipt | `merchant_name`, `total_minor`, `currency` | `event_id` |
| product | `brand`, `model_number`, `category` | — |
| task | `status`, `priority`, `due_at`, `scheduled_for`, `completed_at` | `parent_id` |
| thread | `status`, `last_message_at` | — |
| item | `category`, `brand`, `model` (from `ci.objects`, keyed by `object_id`, which is the document's `entity_id`; `pipeline/stages/index/entityRows.ts` `loadItemRows`) | — |
| note, concept | none | — |

#### Conversation key

`related_id` stays a uuid for every type. For communications it is a uuid v5
of `user_id`, `source_system` and the raw `thread_id`, computed in the SQL
(Postgres `uuid_generate_v5` with a fixed namespace constant; `uuid-ossp` is
installed on the dev database, checked 2026-10-21; U1 confirms the setup
migration installs it everywhere).

Why all three inputs: `thread_id` is unique only within one account and one
source. 1,482 email thread ids are shared by two of Kyle's accounts, covering
3,748 messages. Hashing the raw text alone would merge different people's
conversations.

The raw `thread_id` is not synced, and is not searchable today either:
`communicationWeightedTexts` (`search-ingress/searchTexts.ts`) indexes only
the subject and the preview. Many ids are readable chat names rather than
random characters (Messenger `Fantastic Five`, Discord `Direct Message with
…`, Reddit `r/…`), so the one-way hash loses no search value. Showing a
readable name as a conversation heading is a possible later `detail` field.

**Measured 2026-10-21 (Kyle's corpus): the conversation view is only as good
as the imported `thread_id`:**

| source | messages | distinct `thread_id` | note |
|---|---|---|---|
| facebook_messenger | 163,398 | 25 | readable group/person names |
| sms_backup_restore | 19,163 | **0 (all NULL)** | no conversation at all |
| discord | 13,553 | 218 | readable |
| whatsapp | 5,213 | **1** | every message under the literal `whatsapp` |
| email | 4,115 | 1,838 | random 16-hex |

A NULL `thread_id` gives a NULL `related_id`, and the record page shows no
"conversation" section rather than an empty one. **SMS and WhatsApp are
import defects, out of scope here.** The SMS importer could derive a
conversation from the other party's number. The WhatsApp importer should use
the chat name from the export. Tracked as follow-ups. Inferring conversations
from participants on the server for this plan would be fragile for group
chats.

**Deliberately left out,** to hold the line the original plan drew (names on
the device, no dossiers): `birth_date`, every geography column,
`payment_last4`, `license_key`, `dossier`, `properties`, raw `metadata` and
`source_data`.

**Where it is computed: in SQL, in the one shared statement.**
`buildVectorUpsertStatement` (`search-ingress/services/VectorService.ts:130`)
already derives `occurred_at` from the source row with `entityTimeSql('v')`,
a per-type `CASE` of primary-key subqueries (`search-next/entityTime.ts`;
since 2026-10-26 a place's time is its latest visit -- the start of the newest
event held there, kept current by the same statement when an event is indexed
-- rather than the moment the pipeline promoted it, which put every promotion
burst at the top of the phone's "most recent"). A
sibling `entityDeviceRecordSql('v')` returns `related_id` and `detail` the
same way. Merging both into one `LEFT JOIN LATERAL` makes it a single lookup
per write instead of two.

Because of that, none of the 17 live listeners and none of the 6 pipeline
vector stages change. They keep passing weighted texts, and both write paths
stay identical by construction. The cost is one more primary-key read per
index write. The stage versions are bumped anyway (below).

### Backfill

Existing rows need `related_id` and `detail`, and two groups of entities need
a document they have never had.

- **Existing documents: a versioned in-place refresh.** Since `detail` is a
  pure SQL function of the source row, existing documents can be refreshed
  with an `UPDATE` in batches, without re-running the tsvector. Rows with
  `detail_version < N` are rewritten by a worker cron in batches of a few
  thousand, and bumping N later re-derives every row. This is the same idea as
  pipeline `stage_version`, and it is not a data-fix migration (see
  `no-data-fixup-migrations`): it runs on every install, now and on every
  future change.
- **Notes, threads, tasks and places with no document:** these types have no
  pipeline stage and no backfill lane, so today they get a document only when
  next written. That is why the phone has 1 note and 7 threads but **0**
  searchable entries for either. Add lanes for all four to
  `SearchIndexBackfillService`, which already covers concepts, products and
  receipts. **Needed in any model.**

### What syncs after

| table | today | after |
|---|---|---|
| `mobile_search_documents` | synced | synced, plus `related_id` and `detail` |
| `notes` | synced, read-only in practice | synced and **written offline** (U5) |
| `tags` | synced | synced (tag suggestions in the search box) |
| `entity_tag` (its own bucket) | synced, never read | **kept** (Kyle 2026-10-21) for offline tag filtering. U3 reads it |
| `events`, `entities` | synced, never read | **dropped** |
| `files` | synced, never read | **dropped** |
| `threads`, `messages` | synced, never read | **dropped.** In-app LLM chat history is not needed offline; the thread's search entry and summary are enough (Kyle 2026-10-21) |

Dropped: `events`, `entities`, `files`, `threads`, `messages`. Kept: `notes`,
`tags`, `entity_tag`, `mobile_search_documents`.

Every removal is one sync-rules change: one full re-download per phone,
measured at about 3 minutes since the soft-heap fix. U1 makes all the
sync-rules changes at once so phones pay for it once.

Follow-on cleanup, deliberately not part of this work: with `events` and
`entities` no longer synced, `sync_period`, `SyncWindowSweepCron` and the
`POWERSYNC_TABLES` entries for those tables have no purpose.

**Expected size** (an estimate, to be measured in U2): about **0.55–0.6 GB**
on a production phone for Kyle's corpus, down from about 0.85 GB today. That
is about +110 MB for the display fields and about −0.4 GB for the dropped
tables.

### Phases (replacing P2–P4)

| # | Deliverable | Touches |
|---|---|---|
| U1 ✅ 2026-10-22 | Server: migration (`related_id`, `detail`, `detail_version`); `entityDeviceRecordSql` in the shared statement; detail-refresh cron; note/thread/task/place backfill lanes; **one** sync-rules change (new columns, the five tables dropped); `POWERSYNC_TABLES` | migration, `VectorService.ts`, `search-next`, `SearchIndexBackfillService`, `sync-rules.yaml`, `setup-database/entrypoint.sh` |
| U2 ✅ 2026-10-22 | Device: raw-table DDL gains the two columns plus a `related_id` index; `schema.ts` drops the five tables; `connector.ts` read-only list updated; `localSearch.ts` reads `detail`; measure size and first-sync time | `searchIndex.ts`, `schema.ts`, `connector.ts`, `localSearch.ts` |
| U3 ✅ 2026-10-22 | **Offline Memory list (was P3):** a committed search on `/memory` while not connected renders `LocalListView` (icon, title, type, time, snippet; relevance or recent; paged), so "Search all of Memory for…" works offline. Tag filters (`?tags=`) apply offline through the kept `entity_tag` and `tags` tables, joined on `(entity_type, entity_id)`; the tag suggestion in the search box (`/memory?tags=…`) then works offline too. Also fixes **file results doing nothing when tapped**: `GlobalSearchBox`'s navigation switch has no `file` case, online or off | `MemoryPage`, `ExploreView`, new `LocalListView`, `GlobalSearchBox.tsx` |
| U4 ✅ 2026-10-22 | **Offline record page (was P4):** one page for every type at a dedicated route. It renders title, body, time, type and `detail` with per-type labels; communications show their conversation (siblings by `related_id`, in order); a banner reads "Saved on this phone"; and "Open full record" appears once connected. Offline result taps route here; online taps keep today's per-type pages | new page + route, `GlobalSearchBox.tsx`, `LocalListView` |
| U5 ✅ 2026-10-22 | **Offline notes:** on the phone, `NotePage` and the notes list read and write the local `notes` table, and PowerSync uploads through `connector.ts`. Fixes the noted id-reconciliation gap by adding an optional `id` to `CreateNoteInput`, which `NoteService.create` already accepts, so an offline-created note keeps its id. Then **regenerate GraphQL codegen** (`make graphql`) | `NotePage`, `NotesPage`, `connector.ts`, `NoteResolver`, codegen |
| U6 ✅ 2026-10-22 (iOS uncompiled) | **On-device model tool (was P2):** Android `LocalSearchTool` and iOS `LocalSearch.swift` (uncompiled), reading the same table. Bound when the appliance's tool list cannot be fetched, which today leaves the model with **no tools** (`IntentToolProvider.buildTools`, `CompanionIntentTools.refreshRulings`), and preferred while not connected. Same lean `knowledge.search` parameters and the same result shape | `capacitor-local-llm`, iOS `LocalLLM/` |
| U7 ✅ 2026-10-22 | Offline end-to-end test on the phone, with the API stopped and the Vite tunnel kept up (not airplane mode; see below) | — |

U3, U4 and U5 are independent of each other once U2 lands. U6 depends only on
U2's table shape.

### U1 status (2026-10-22)

Implemented, uncommitted, all checks green (be-api typecheck, lint, the three
touched unit suites, and the new integration suite under `make test-db`):

- Migration `20261021203300_mobile_search_document_detail` adds `related_id`,
  `detail`, `detail_version` (default 0) and the `(detail_version, id)` index,
  and installs `uuid-ossp` itself. The setup container and
  `scripts/test-db/bootstrap.sql` install it with the other extensions too; the
  dev database already had it in `public`, which the API's `search_path`
  (`ci,public`) reaches. Applied to the dev database.
- `search-next/entityDeviceRecord.ts`: `entityDeviceRecordSql`, the per-type
  recipe of the table above, with `DEVICE_RECORD_VERSION = 1` and the
  conversation uuid v5. `buildVectorUpsertStatement` joins it `LEFT JOIN
  LATERAL` beside `entityTimeSql`, so listeners and pipeline stages are
  untouched.
- `maintenance/cron/MobileSearchDocumentDetailCron`: every 10 minutes at
  xx:x7:58 (`role: 'worker'`, exclusive), up to 40 batches of 5,000 rows below
  the version, `FOR UPDATE SKIP LOCKED`, touching `updated_at` so PowerSync
  re-sends the row. **Measured on the dev corpus: one 5,000-row batch takes
  about 0.28 s**, so the 598k existing rows converge in three ticks (about 30
  minutes after the worker first runs it) for about 35 s of database time.
- Backfill lanes for `note`, `thread`, `task` (with its owner, which the task
  listener needs) and `place` in `SearchIndexBackfillService`. On the dev
  database today there are 0 note, thread and place documents and 4 task ones.
- Sync rules: `related_id` and `detail` selected; `ci.events`, `ci.entities`,
  `ci.files`, `ci.threads`, `ci.messages` removed. `POWERSYNC_TABLES` in the
  setup container shrunk to match, and `create_publication` now drops a
  publication member that left the list (the dev database's `powersync`
  publication still carries the five until `make dev` re-runs the setup
  container; the PowerSync service also needs a restart to load the rules).

Not done, by design: the device side (U2), which still declares the five
tables in `schema.ts` and ignores the two new columns until it changes.

### U2 status (2026-10-22)

Implemented, uncommitted, all checks green (fe-web typecheck, lint, the
PowerSync and search-box suites). Verified on the S23U against the dev stack.

- `searchIndex.ts`: the raw table gains `related_id` and `detail` (both TEXT;
  `detail` is the JSON as sent) and a partial index on `related_id`. An
  existing replica is migrated in place: `ensureDocumentsTable` reads
  `pragma_table_info` and `ALTER TABLE … ADD COLUMN` for each column in
  `DOCUMENTS_ADDED_COLUMNS` (SQLite has no `ADD COLUMN IF NOT EXISTS`). The
  `put` upsert and the `ps_untyped` adoption carry both columns.
- `schema.ts`: `events`, `entities`, `files`, `threads`, `messages` gone;
  **`entity_tag` declared** (it was synced into `ps_untyped` before, where
  nothing could read it — U3 needs it), with indexes on `(entity_type,
  entity_id)` and `tag_id`. PowerSync dropped the five `ps_data__*` tables on
  first open.
- `connector.ts`: read-only list is `tags` and `entity_tag`; a stale CRUD entry
  for a dropped table falls into the existing "unrecognized table" drop.
- `localSearch.ts`: `DocumentRow` reads the two columns; `parseDetail` /
  `toLocalDocument` give a `LocalDocument` with `detail` parsed, and
  `searchLocal` returns `documents` (every hit, including types the header box
  has no row for) beside `nodes`, for U3's list and U4's page.

**Measured on the dev phone (S23U, 2026-10-22, replica from 2026-10-21):**

| | |
|---|---|
| Cold start → connected | 10 s |
| Re-download (sync-rules change) | 1,178,801 ops — about 2× the 589k rows, because the U1 refresh cron had re-sent every row once on top of the new bucket's snapshot |
| Download + apply + FTS rebuild | 5 min 40 s (10:10:04 → 10:15:44); about 7 min from cold start |
| Rows on device | 589,404 documents; `detail` on 585,364; `related_id` on 309,591 (181,844 communications → conversation, 127,739 content → event, 8 places) |
| Live size | **1.05 GB** (257,296 × 4 KB pages in use) |
| File on disk | 2.06 GB — 246k pages free after the old bucket's rows were deleted; SQLite does not give them back without `VACUUM` |

Where the 1.05 GB goes (`dbstat`): `ps_oplog` 559 MB + `ps_oplog_key` 101 MB
+ `ps_oplog_row` 47 MB — PowerSync's own copy of every row, kept for raw
tables too — then the documents table 239 MB, FTS 45 MB, the id index 31 MB,
the `related_id` index 16 MB. **The oplog copy is two thirds of the replica.**
The plan's 0.55–0.6 GB estimate did not count it, and it also means `detail`
is paid for twice. Two follow-ups, not done here: `VACUUM` after a bulk
download to shrink the file (the free pages are reused otherwise, so this is
cosmetic until the next re-download doubles the file again), and whether the
oplog copy can be trimmed (PowerSync keeps it to re-apply checkpoints).

**Trimmed the same day (Kyle, 2026-10-22):** the sync rule no longer sends
`user_id`, `created_at` or `updated_at` for the documents — the device never
stored them, but the oplog did. Re-measured on the same phone after the
re-download (590k operations, 4 min 24 s download + apply + rebuild):

| | before | after |
|---|---|---|
| oplog JSON per row | 605 B | 470 B |
| oplog JSON total | 339 MB | 264 MB |
| `ps_oplog` table | 559 MB | 442 MB |
| live replica | 1.05 GB | 0.96 GB |

What is left in the oplog JSON per row (measured before the trim, so the
three columns are gone from it now): `detail` 73 MB, the three uuids as text
51 MB, `body` 26 MB, `title` 24 MB, and about 115 MB of JSON keys and
punctuation. The searchable text is about 5% of the replica.

**Considered and rejected for `detail`:** PowerSync sends json/jsonb only as
text, and writes absent columns as `"col":null`, so neither a nested object
nor splitting the fields into columns helps. Shorter keys plus omitting
default values would save about 30 MB (3%) at the price of cryptic keys in
the record-page code and a `DEVICE_RECORD_VERSION` bump; Kyle chose to keep
the readable keys. The remaining size is PowerSync's design: a device record
costs about 1.6 KB on disk all in, so the replica is sized by how many
entities a phone carries, not by how lean each one is.

Also seen: this phone's user owns no tags on the dev server, so `tags` and
`entity_tag` are legitimately empty here; the server replicated 5,606
entity_tag rows for other users. And a page *reload* over a live native
connection (Vite HMR style) left the old pool's connection open and the new
page's first write got `database is locked`; a cold start is clean. The
`useSearchService` "network failure falls back" test is flaky independent of
this change (passes one run, fails the next).

### U3 status (2026-10-22)

Implemented, uncommitted, all checks green (fe-web typecheck, lint, 220
tests across the PowerSync, search-box and Memory page suites). Verified on
the S23U with the API stopped (`overmind stop api`, tunnels up).

- **`api/powersync/localList.ts`**: the offline list query — a page of
  device records for a text query (FTS5, prefix terms, bm25 with the title
  over the body), a browse (newest first), the type scope, `?tags=` (every
  label, through the synced `entity_tag` + `tags`, the appliance's
  semantics), and a `from` / `to` range over `occurred_at`. `countLocal` is
  separate so the first page never waits for it.
- **`pages/MemoryPage/LocalListView`**: rendered by `ExploreView` in place
  of the appliance's list when `answersFromDevice` says so (connection chip
  not `connected` once the first probe has settled, or the appliance request
  failed on the network; never without a synced replica, so a desktop browser
  keeps its error state). Same URL, same type resolution as the online list
  (`localListOptionsFromParams`), paged on scroll, "Saved on this phone"
  caption, and a line naming the one filter the device cannot apply
  (semantic search).
- **`components/SearchBox/entityRoute.ts`**: the one tap-to-route table the
  header box and the offline list share. The header box's `file` case now
  opens the gallery searched for the file's name (it used to do nothing,
  online or off); a file still has no page of its own, which U4's record page
  will give it.
- `entity_tag` is now declared on the device (U2 did that) and indexed, so
  the tag suggestion `/memory?tags=…` works offline too.

**Every explorer filter but semantic search applies offline (Kyle,
2026-10-22: the size is worth it, and geography may go on the device now
that the replica is encrypted).** Recipe version 2 adds to `detail`:
`source_system` on every type that has one (the How filter); a message's
`from_id` and `to_ids` and an event's `people` as person ids (the Who filter
matches names against the phone's own person records, then looks for their
ids on the record, bound to the role a direction implies — received FROM,
sent TO — exactly as `CommunicationService.applyPeopleFilter` does); an
event's `location_id` beside `location_name` (Where); `lat` / `lng` on
events and places (hasLocation, map areas). `eventTypes`, `direction` and
`fileKinds` read fields the record already had. Each filter pins the type
scope the way `SearchResolver` does: direction → messages, event kinds /
places / coordinates → events, file kinds → files, people → messages and
events. The relationships table (1.8M rows) is not needed: the ids the
appliance filters on sit inline on the message and event rows. Average
`detail` grew from 112 to 570 bytes on the first 200k refreshed rows.

**Measured on the dev phone (589k records; every page under ~1 s of database
time once the planner is steered — see below):**

| URL | rows | footer |
|---|---|---|
| `?search=lunch` | 30 | 30 of 308 |
| bare browse | 30 | 30 of 589,404 |
| `?includedEntityTypes=Receipt` | 30 | 30 of 1,779 |
| `?tags=vacation` (this user owns no tags) | 0 | empty state |
| `?from=2024-01-01&to=2024-12-31&sortBy=time` | 30 | 30 of 52,721 |
| `?search=the&people=Ana` | 30, "filters ignored" line shown | ranks 187k hits in ~5 s |

**SQLite's planner on the device needs steering, and this is the part worth
knowing before touching these queries.** The replica has no statistics, and
each query shape chose badly at least once (all S23U, 589k rows):

- A text query, offered the `(entity_type, occurred_at)` index, scanned every
  row of the chosen types and probed FTS per row: **15 s** for "lunch"; with
  the FTS scan driving, ~0. This also hit the header box's suggestions. Fix:
  the unary plus on the type term (`+d.entity_type IN (…)`), SQLite's
  documented way to keep a term off every index, whenever a query is present.
- A broad scope in time order (bare browse, a year of messages) used the
  type index and sorted every matching row in a temp b-tree: **2.4 s**; the
  plus again, walking `occurred_at` backwards: ~0.
- A narrow scope (Receipts, Tasks) in time order walked the whole time index
  past every other row: **5 s**; its own `(entity_type, occurred_at)` range:
  ~0. So the plus applies only when the scope keeps messages, events or
  content (95% of the rows).
- A count over a type scope and a date range, index-only from
  `(entity_type, occurred_at)`: ~0; through row lookups, 5 s. Counts never
  take the plus.
- A tag filter as a correlated subquery over all rows: **29 s**; as a plain
  JOIN the planner scanned the documents and probed the tagged set: **10 s**;
  `CROSS JOIN` with the tagged set on the left, into the `entity_id` index:
  ~0. Behind a text query the correlated form is a per-hit probe and is the
  right one (~0 for a rare word, 2.9 s for "the").

**The filter fields are virtual generated columns with partial indexes.** A
filter over the JSON itself is a `json_extract` per scanned row: a place
name over 224k events took 20 s, a person's name as an event participant
15 s. `searchIndex.ts` declares each filter field as
`GENERATED ALWAYS AS (json_extract(detail, '$.x')) VIRTUAL` (computed on
read, stored nowhere; added to an existing replica with `ALTER TABLE`, which
`pragma_table_xinfo` — not `table_info`, which hides generated columns —
checks first) and indexes it partially where sparse: coordinates (2.7k
events), places, an event's people (hundreds), and with time order where
dense: `(source_system, occurred_at)`, `(from_id, occurred_at)`,
`(occurred_at) WHERE to_ids IS NOT NULL`. The query must say `IS NOT NULL`
itself for SQLite to pick a partial index, and both branches of the place
filter's OR are qualified so the multi-index OR serves each from its own.
Measured after: every filter ~0 on its own; the worst Who case (an old
correspondent as recipient, walked through the `to_ids` index with
`json_each`) 0.5 s. `instr` over the array text re-ran the name subquery per
row (12 s); json_each does not.

**The Who filter is two plans, chosen by a count.** A person's records are
found either by walking the time index and testing each row with `instr`
over the id columns (instant for someone in many records — a spouse, 158k
of 589k — because the first page is in the first few hundred rows; 12 s for
an old correspondent in 153, because nearly the whole table is tested
first), or through the FTS index, which now also holds `from_id`, `to_ids`
and `people` as text — a uuid tokenizes into its five hex groups and the
filter asks for them as a column-scoped phrase (instant for the rare
person; 6 s for the frequent one, because every match is joined and sorted).
`planPeople` resolves the names to ids first (a subquery per row re-ran the
name match 589k times), asks the FTS index how many records match (53 ms
for 158k), and takes the walk above 2,000. With a text query the ids simply
join the MATCH, which is cheap either way. The FTS postings cost 26 MB for
1.56M recipient entries; a side table of the same was 218 MB and slower for
the frequent case. Text queries are column-scoped (`{title body}:`) so a
hex-looking word cannot hit the id columns.

Two more planner rules, found on the phone: a filter with an index of its
own (connector, event kind, place, coordinates) must drive, so the type term
takes the plus whenever one is present (the place filter's multi-index OR
ran in ~0 that way and in 20 s with the type index walking every event);
and behind a text query every field takes the plus, so the FTS scan drives
("beatles" within Spotify and YouTube: 22 s with the connector index
driving and FTS probed per row, ~0 the other way). The count behind a
walk-plan Who filter would test every row (10 s) and, on the plugin's one
thread, hold up every query after it, so it is the FTS count when the Who
filter is the only narrowing and otherwise unknown ("30 loaded"). A very
common word ("the", 187k hits) still costs about 5 s to rank, which is the
bm25 sort itself.

Thirteen indexes on the device table now, about 160 MB, built once on open
(~45 s on the S23U). None is needed by the sync client's upsert, so
`watchBulkDownloads` drops them all with the FTS triggers for a bulk download
and rebuilds them after; `ensureDocumentsTable` recreates any missing one on
the next open if the app died in between. `ANALYZE` after a bulk build might
make the planner hints unnecessary; not tried.

Also seen: `occurred_at` is stored as Postgres text, `YYYY-MM-DD HH:MM:SS[.f]Z`
with a space, so an ISO bound with `T` skipped the first day of a range;
`occurredAtBound` rewrites both bounds (lower inclusive at the second, upper
exclusive at the next second). And Vite HMR of a module in the
PowerSyncProvider's import graph re-opens the database over the live pool
and every query then fails with `database is locked` until a cold start —
reload the app after editing those files, not the page. Seen for a hot
update of LocalListView.tsx alone too, so in practice any hot update; and
the app lock engages on some cold starts, which needs the phone in hand.

### U4 status (2026-10-22)

Implemented, uncommitted, all checks green (fe-web typecheck, lint, 885
tests across the PowerSync, search-box, Memory page and record page
suites). Verified on the S23U connected and with the API stopped.

- **`pages/LocalRecordPage`** at `/memory/saved/:type/:id` (raw id, like
  `/people/:id`): the record's title, text, time and type, the `detail`
  fields with per-type labels (`recordDetail.ts` — participants as "From …
  · To …", a size in units, a receipt total with its currency, coordinates
  as one pair; the person and place ids the filters use are not shown; a
  field the server adds later shows under its own name), a "Saved on this
  phone" badge, and **Open full record** to the type's own page only while
  the connection chip says `connected`. A missing record says "Not saved on
  this phone".
- **Conversation**: a message lists the siblings sharing its `related_id`
  in time order, twenty either side with "Show earlier" / "Show later"
  (`api/powersync/localRecord.ts`, keyset on `(coalesce(occurred_at,'~'),
  id)` over the `related_id` index), the message highlighted, a sibling tap
  opening its own page. A 21,388-message Messenger group renders at once.
  Any other record with a `related_id` that is an entity (a sub-event, a
  file in a folder, content from an event) shows "Part of" with that
  record when the phone holds it.
- **Routing**: `savedRecordRoute` in `components/SearchBox/entityRoute.ts`.
  The offline list's rows and the header box's device-sourced suggestions
  open it, for every type including files; online suggestions keep the
  per-type pages (and the gallery for files).

### U5 status (2026-10-22)

Implemented, uncommitted; checks green (be-api typecheck and lint; fe-web
lint, note suites). Server: `CreateNoteInput.id` (a global id, optional) →
`NoteResolver.createNote` → `NoteService.create`, which already honoured a
given id; `make graphql` regenerated. Client:

- **`api/powersync/localNotes.ts`**: watched reads of the local `notes`
  table (`@powersync/react`'s `useQuery`), and create / update / delete as
  plain SQL. A create sets both timestamps and no `user_id` — the server's
  row carries it when it syncs back.
- **`pages/NotePage/LocalNotePage.tsx`** and
  **`pages/NotesPage/LocalNotesList.tsx`**: on a phone with a replica the
  note pages read and write the local table and nothing else, online or
  off. The same editor, autosave and minted-id session as the appliance page
  (`noteText.ts` holds the shared helpers); the status shows a phone glyph
  with the time. `NotePage` / `NotesPage` pick the local page when
  `getReplicaDatabase()` is set, the GraphQL page otherwise, so the browser
  and the tests are unchanged. `DeleteNoteModal` takes an `onDelete` for the
  local delete.
- **`connector.ts`**: a note PUT sends `id: GlobalUID.encode('note', op.id)`,
  so the server keeps the row's id and the note that syncs back is this row.
  That closes the id-reconciliation gap the connector's header described.
- **`session.ts`**: `getReplicaDatabase()` — the bound database only when it
  is the phone's encrypted replica. The browser binds its plaintext
  placeholder too (never connected, wiped on load), and U3's fallback and
  the header box's device search were reading from it: a desktop browser
  with the appliance down would have shown "Saved on this phone" over an
  empty table. Every offline reader now uses `getReplicaDatabase()`.

Verified on the S23U with the API stopped: a note typed at `/notes/new`
became `/notes/<minted id>` with one queued write, an edit followed, the list
showed it; with the API back the server held the row under the same id with
the user set, the queue drained, no duplicate; a delete from the list left
both sides. The appliance pages' own tests are untouched (they see no
replica).

Also: `useOptionalConnectionMode` (packages/common) for UI that renders in
trees without a connection probe. `useSearchService` uses it, which fixed
`PersonPage.test` — it had been failing since the probe was added, because
the page's AddRelationshipModal mounts the search box without a provider.

Not done: the capture outbox path (`captureNote` through the LocalHub
sidecar) remains the fallback where there is no replica, and is untouched.

### U6 status (2026-10-22)

Implemented, uncommitted. Android unit-tested (Robolectric); iOS written and
**uncompiled** (`LocalSearch.swift` carries the three things to check on a
Mac at its top).

- **Android** (`packages/capacitor-local-llm`, `intents/`):
  `LocalSearch.kt` — the lean `knowledge.search` arguments, the SQL
  (`localList.ts` in Kotlin, same planner steering), and the appliance's
  result envelope with `mode: "local"` and a lean hit (id, type, title,
  link to the saved page, time, text, display fields; the filter ids left
  out); `LocalSearchStore.kt` — opens the replica read-only through
  SQLCipher with the SQLite plugin's own passphrase
  (`EncryptedSharedPreferences` file `sqlite_encrypted_shared_prefs`, key
  `secret`, AndroidX master key), one open per call; `LocalSearchTool.kt` —
  an `OpenApiTool` named `knowledge_search` with the lean schema copied in
  (the catalog that publishes it is exactly what is unreachable when the
  tool is needed), results shaped by `ToolResultShaper` like any other.
- **Binding** (`IntentToolProvider.toolsForLoad`): the phone's tool joins
  the set when a replica is there — in place of the appliance's
  `knowledge_search` while not connected, and as the whole set when the
  catalog cannot be fetched, which until now left the model with no tools.
  JS hands over what the native side cannot know
  (`configureIntentTools`: `connectionMode`, the chip's latest answer via
  `getLatestConnectionMode()`, and `localSearch.databaseFile`, set by the
  PowerSync provider when the encrypted replica binds —
  `NATIVE_DB_ON_DISK_FILENAME`, `ci-powersyncSQLite.db`). Both are part of
  the tool-set key, so a change rebinds on the next load.
- **Tests**: `LocalSearchTest` (SQL, bounds, envelope, arguments),
  `LocalSearchToolTest` (declaration held against the TypeScript lean form
  through `RepoFiles`; shaping; the three binding rules),
  `SqliteReplicaDriftTest` (the plugin's file, key, master-key scheme, file
  suffix and dependency pins, read from the vendored source).
- **Dependencies**: `net.zetetic:sqlcipher-android:4.10.0@aar`,
  `androidx.sqlite:sqlite:2.4.0`, `androidx.security:security-crypto:1.1.0-alpha06`,
  the SQLite plugin's exact pins, so the app links one copy of each.
- **iOS**: `LocalSearch.swift` (tool + store over `sqlite3_key`, keychain
  item `unlockSecret` / `<prefix>secret`), `CompanionToolContext.withLocalSearch`
  and `localSearchPreferred`, the plugin reading the two new fields.

### U7 status (2026-10-22)

Run on the S23U with `overmind stop api` and both `adb reverse` tunnels up,
driven over CDP (`u7.mjs` in the session scratchpad: `goto`/`click`/`type`/
`eval` against the app page).

**Blocker found and fixed: a cold start with the appliance down signed the
phone out.** `ProtectedRoute` and `RedirectKnownUser` treat "no user" as
"signed out", and the `me` query failing (the Vite proxy's 500, or a dead
origin) left no user, so the app landed on cloud-connect showing "Received
status code 500" with nothing offline reachable behind it. Every earlier
offline check had been on a warm app, where `ProtectedRoute` keeps the page
once shown. Fix: `hooks/rememberedUser.ts` — on a phone, `useCurrentUser`
keeps the profile the appliance last returned (localStorage, per origin) and
answers with it when the query fails with a transport error that is not a
401/403; a GraphQL-level error or a rejected key still signs out, and the
profile is forgotten with the device key. `useCurrentUser` now also reports
`remembered`. **A phone must have started once against the appliance for
the profile to exist** — a fresh install started offline still goes to
cloud-connect, which is right.

Checked offline, all from the replica:

- Cold start lands on `/memory?view=list` with the "Saved on this phone"
  caption; the chip reads "On this phone" (the LocalHub sidecar answers).
- List filters by URL: text (`search`), date range (`from`/`to`), connector
  (`connectors=spotify`), direction, `hasLocation`, place (`places=` takes a
  **name**, matched against the phone's place titles and `location_name`),
  person (`people=` takes a **name**), person + text, person + direction,
  an unknown tag (empty state, no crash). Each page rendered in ~1.3 s
  including the driver's own overhead. Note: the explorer itself drops
  `sortBy=time` when a text query is present (the URL is rewritten to
  `?view=list&search=…`), online and offline alike; the offline sort path
  was checked directly through `listLocal` and orders newest-first.
- Header search box: "From this phone" results for a name.
- Record page: a person row opens `/memory/saved/person/<id>` with the
  "Saved on this phone" badge and its fields.
- Notes: the list shows the synced note; `/notes/new` creates a note that
  lands in the local `notes` table with one row queued in `ps_crud`; typing
  into it again updates the row in place (still one queued op).
- On-device model: `knowledge_search` bound as the only tool (the catalog is
  unreachable), the replica answered ("cookies": 10,145 bytes, shaped to
  1,973), the model listed the hits.
- Events, map and gallery views showed their "couldn't load" state offline
  and people "Could not load people… Try again" — none crashed. Kyle then
  asked for the events, timeline, map and people views offline, and an
  offline-specific message for the rest; see "U8" below.

Recovery, with the app left in the foreground: the API came back at
14:28:02 and the replica's `lastSyncedAt` was 14:28:07, the `ps_crud` queue
was empty, and the connection mode was `connected` — no cold start needed.
The note, with its offline edit, was on the server (shown by the online
notes page) and its deletion synced back to the phone. The earlier note
that PowerSync "does not reconnect after an API restart until a cold start"
did not reproduce here; it was seen after a nodemon restart with the page
having reloaded, and is most likely the "database is locked" state a Vite
reload leaves the plugin in, not a sync-client fault.

### U8: the other views offline (2026-10-22)

Asked for after U7: the events chronology, the timeline tab, the map and
the people page answer from the phone; the views that cannot say so in
their own words. Gallery stays online-only by Kyle's choice (size — the
thumbnail numbers are below). Implemented, uncommitted, verified on the
S23U with the API stopped and a cold start.

- **One rule for every offline surface:** `api/powersync/deviceFallback.ts`
  — `answersFromDevice` (moved from `ExploreView/`, re-exported there) and
  the hook `useAnswersFromDevice(error?)` over the connection probe and the
  replica. The everything browse, the chronology, the timeline, the map,
  the people page and both error-state components read it, so they flip
  together.
- **Events chronology** (`/memory/events`, `ListView`): renders
  `LocalListView` offline — the device's happenings newest first as a flat
  list, no date headings.
- **Timeline tab** (`StoryTimelineView`): renders `LocalListView` in time
  order (`sort` prop, direction from `sortOrder`) instead of the TimelineJS
  deck, which is built from hydrated entities and media the phone does not
  hold.
- **Map** (`MapView`): a third pin source, `useLocalPins`, over
  `listLocalPins` in `localList.ts` — the same URL filters as the list,
  `hasLocation` forced as `mapPins` forces it, newest first, capped at the
  appliance's 10,000. A pin tap opens the saved record page (`Pin.route`);
  a "Saved on this phone" pill says the background tiles need the network
  (the tiles that happen to be cached still draw). **Planner trap:** offered
  the time index for the ORDER BY, SQLite walked all 589k rows testing
  `lat` (a JSON extraction) per row — 37 s for 2,729 pins. The statement
  names the geo index outright (`INDEXED BY`) when the plain table drives:
  288 ms for the whole located set, 158 ms behind a text query (the FTS
  scan drives there, and `INDEXED BY` is left off since it would refuse
  that plan), 186 ms behind a connector.
- **People** (`/memory/people`): `LocalPeopleList` over `localPeople.ts` —
  the 2,169 person records by name, or ranked by the FTS index for the
  header box's `?search=`, 30 a page; each row opens the saved record. The
  subtitle is the record's text minus its search-only JSON tail. No merge
  queue, identifiers or interaction counts.
- **Offline message:** `components/ErrorState` picks "Needs the Memory
  server" + what the phone still serves when the rule says offline and the
  caller gave no copy of its own; the Memory wrapper defers to it. Covers
  the gallery, the lazy-view chunk failure and every page that renders the
  default. The graph modal, which prints its transport error inline, says
  the same words. The per-type online pages (person, place, …) keep their
  own copy; offline taps never reach them.

**Gallery thumbnails, for the size decision (dev database, 2026-10-22):**
26,118 originals (25,074 images, 625 videos; 271 GB). The pipeline keeps
one `PREVIEW` per media file, about 244×263 px: 25,717 of them, 406 MB
total, 16 kB mean, 16 kB median, 25 kB at the 90th percentile. So the
ballpark is **~16 kB per photo or video**, i.e. ~400 MB for this library,
~160 MB per 10,000 photos — roughly 40% of the current 1 GB replica for
this data set. (The 376 `THUMBNAIL` rows, 52 kB mean, are a legacy variant.)

**Decision (Kyle, 2026-10-22): sync the current 300 px previews as they
are.** Compared on the S23U (DPR 3.5) against 160/128/96 px renders of the
same ten files, the 160 px ones were already too blurry at the gallery's
3-column tile; the ~0.4–0.5 GB is a small fraction of a 128 GB entry-level
phone. Add a Settings option to turn preview syncing off for anyone who
wants the space back. Not started; see "U9" when it is written up.

### U9: photo previews on the phone (2026-10-22)

Implemented, uncommitted. The decision above, built on PowerSync's
attachments pattern.

- **Server.** The content and file device records carry `preview_id` — the
  ORIGINAL file's id, set only when a PREVIEW rendition exists
  (`previewOf` in `entityDeviceRecord.ts`; `DEVICE_RECORD_VERSION` 3, so
  the refresh cron re-derives every record). `GET /api/files/:id/preview`
  (`FilesController.preview`) streams the rendition by the original's id,
  behind the JWT-or-API-key guard, `Cache-Control: private`. The phone
  reaches the appliance, not its object store, so no signed URL.
- **Device.** `preview_id` is a generated column with a partial index
  (`preview_idx`). `schema.ts` adds the local-only `attachments` table
  (`AttachmentTable` from `@powersync/attachments` 2.4.3 — the 3.x line
  needs `@powersync/common` 2). `api/powersync/previews.ts` is the store:
  the setting (`ci.previewSync` in localStorage, on by default), a
  `StorageAdapter` over `@capacitor/filesystem` 7 (app data directory,
  `previews/<fileId>.jpg`), and `PreviewQueue extends
  AbstractAttachmentQueue` with four things changed from the base class —
  the ids come from one `SELECT DISTINCT preview_id` after each checkpoint
  rather than a `watch` on the raw table (which fires per row write);
  reconciliation is set-based and batched (the base class scans the ledger
  per id, 25k × 25k); downloads go through the API with the device key, a
  404 archives the row and any other failure rests the queue for a minute;
  and the eviction limit is effectively off (the base evicts past 100
  files). `PowerSyncProvider` starts it when the encrypted replica binds
  and follows the setting.
- **Settings → Your data** (`WorkingSetSection`): "Keep photo previews on
  this phone" with the count, bytes and what is still to fetch. Turning it
  off opens a dialog with Cancel / Keep what's here, stop fetching / Delete
  previews and stop; on needs no confirmation.
- **Consumers.** The gallery tab offline (`LocalGalleryView`: the offline
  list with `hasPreview`, which pins the scope to content and file rows
  with a preview and shows each photo once — a photo is usually both a
  content row and a file row sharing one preview), newest first, tiles from
  the store, a glyph for a preview not yet arrived, tap → saved record
  page; and the saved record page shows the preview large.
- **Measured on the S23U:** the route answers in-app (8.9 kB JPEG); the
  queue fetched ~18 previews/s through the USB tunnel, so a 25k library is
  ~25 minutes; files land under `files/previews/`.

**Verified on the S23U (2026-10-22, API up, then stopped for the offline
checks):** the preview route serves the bytes in-app (200, image/jpeg); the
ledger filled from the refreshed records (3,562 ids at first, 11,345 once
the whole refresh had synced) and the files landed under
`files/previews/`; with the API stopped and a cold start, a saved record
shows its preview (decoded, 274×300) and the gallery tab shows tiles with
images for the previews that have arrived and the glyph for the rest; in
Settings → Your data the switch reads the count and bytes, turning it off
opens the three-way dialog — Cancel left everything as it was, "Keep
what's here" turned fetching off with the files kept, "Delete previews
and stop" emptied the ledger and removed the directory — and turning it
back on refilled the ledger and resumed fetching. Throughput over the USB
tunnel: ~18 previews/s on an idle phone, ~2/s while a bulk sync download
is in flight.

Things learned: the dev Vite server must be restarted after `yarn add`
(PnP map is stale, the page goes blank with "Failed to resolve import");
the unauthenticated 404 on the new route is the guard's route-hiding, same
as the existing PATCH; and the replica's indexes are absent while a bulk
download is in flight (they are dropped and rebuilt around it), which is
why `sqlite_master` showed no preview index right after the version bump.

### Browser visits and document excerpts on the device (2026-10-23)

Kyle noticed browser activity never reached the phone. Two things stopped it:
the raw table is excluded from the sync rules (still is), and the type was not
in `DEVICE_INDEXED_ENTITIES`, so the shared index statement wrote no document
for it. The exclusion had been inherited from the header box, which hides
`browser-activity` and `answer` from its suggestions; it was a search-noise
choice for one dropdown, not a size or privacy one. `file-chunk` was out for
the stated reason "a slice of a file that is already here", which is true of
the row and not of its text: a file's record carries title, description and
filename, so a phrase from inside a PDF found the file on the appliance and
not on the phone.

Both are device-indexed now. Dev corpus on the day: 96,808 visits (≈20 MB of
title + url against 52 MB of document text already synced) and 522 chunks.

- Server: the two types in `DEVICE_INDEXED_ENTITIES`; their device records in
  `entityDeviceRecord.ts` (a visit: url, domain, action_type,
  duration_seconds, source_system; a chunk: `related_id` = its file, plus
  filename, section_title and the page / sheet flattened out of
  `source_locator`). No `DEVICE_RECORD_VERSION` bump: no existing type's
  recipe changed, so the records already on phones are not re-sent.
- Backfill, browser activity: `INDEX_VECTOR_BROWSER_ACTIVITY` 1 → 2 in
  `pipeline/versions.ts`. The vector stage re-runs over every visit on every
  install, local Postgres work only, and the shared statement writes the
  document. The maintenance sweep cannot do this one: it skips rows the
  pipeline ledger covers.
- Backfill, chunks: a `file-chunk` lane in `SearchIndexBackfillService`
  (`BACKFILLABLE_ENTITIES`), re-driving `DocumentParsedEvent` with one chunk
  id per event for chunks that have an index row but no document.
  `FileChunkSearchIndexListener` now skips the embedding call for a chunk
  whose embedding exists, so the re-drive is one index statement per chunk.
  The sweep runs from the maintenance orchestrator (`search_index` leg) and
  after an ingest, not on a schedule; an existing install gets its chunk
  documents the next time either runs.
- Phone: both types in `LOCAL_LIST_TYPES`, so the offline Memory list and the
  What filter show them; a glyph and an untitled fallback in
  `LocalDocumentRow`; labels and the new detail fields on the record page
  (`recordDetail.ts`; a chunk's record page shows its file as the parent
  through `related_id`). Not in `LOCAL_RESULT_TYPENAMES`: the header box has
  no row for either type online, and hides browser activity by default
  (`useSearchService`), so the phone's box matches.
- `routeForEntity` has no destination for either type, as on the appliance
  (both open in the explorer's details drawer online), so the record page
  shows no "open online" link for them.

### Record page: 10 s tap-to-conversation (fixed 2026-10-22)

Kyle saw ~10 s from tapping an offline list row to the saved record
showing. Measured on the S23U: the record itself was instant; the two
sibling pages (`listSiblings` before/after) took ~5 s each, because the
newest message's conversation has 103,803 messages and the `related_id`
index covered only the key — every page sorted the whole thread by
`coalesce(occurred_at, '~')` in a temp b-tree. The index is now
`(related_id, coalesce(occurred_at, '~'), id)` — the exact expression the
statement sorts and seeks by, so the keyset is an index seek — and the old
`related_idx` is dropped on startup (`DOCUMENTS_RETIRED_INDEXES`). After:
before page 7 ms, after page 144 ms, count 133 ms; tap-to-conversation
1.1 s on the first open and 0.5 s after. The first open of the page in a
dev session also pays Vite's unbundled module loading over the tunnel
(~20 s once), which a production bundle does not have.

### U6 specifics found 2026-10-21

- The replica file on Android is `databases/ci-powersyncSQLite.db`, checked on
  the phone. Design § 4's `ci-powersync.dbSQLite.db` is wrong.
- `capacitor-local-llm` has **no SQLCipher dependency.** Only
  `@capacitor-community/sqlite` brings it, so U6 adds
  `net.zetetic:sqlcipher-android` at the version that plugin uses.
- The key is in that plugin's EncryptedSharedPreferences file
  `sqlite_encrypted_shared_prefs` (`CapacitorSQLite.java:153`), stored under
  the plugin's own key name. Reading it from a second plugin couples us to a
  third-party internal, so add a drift test like the adapter's, pinning the
  file and key names.
- The native side does not know the connection mode. JS must hand it over
  (exact bridge call to confirm in U6).

### Testing offline on the dev build

Airplane mode does **not** take the dev app offline. The app loads from
`http://localhost:5173` and reaches the API through `adb reverse` over USB,
which airplane mode leaves up. Test by keeping both tunnels up and stopping
only the API (`overmind stop api`). **Cold-start the app for the real test**
(`adb shell am force-stop com.ci.memory`, then `am start`): a warm app keeps
its page through `ProtectedRoute`'s `shown` latch and hides the sign-out
that U7 found. The phone must have started once against the appliance
first, so that `rememberedUser` holds a profile to answer with. `connectionMode.ts` re-checks the
appliance every 30 s, and `useSearchService` falls back as soon as the mode is
not `connected`. The status chip will read `local` rather than `cached`
whenever the phone's LocalHub sidecar answers, and search treats both the
same. Airplane mode is the right test only on a build that reaches the
appliance over the network.

### Resolved questions (Kyle, 2026-10-21)

1. **`entity_tag`: kept,** for offline tag filtering (U3).
2. **Chat history offline: not needed.** These are in-app LLM chats, so the
   exact history does not matter offline. The thread's search entry and
   summary are enough, and `threads`/`messages` are dropped.
3. **Participants on the device: acceptable.** The replica is SQLCipher
   encrypted (P0.5) and the app lock gates the UI, which is enough to keep
   it from external access.
4. **Conversation key: a fixed-format uuid.** It is derived one-way from user,
   source and raw id, and the raw id is never synced. See
   [Conversation key](#conversation-key), including the SMS/WhatsApp import
   gaps the data check turned up.

### Saved searches on the device (2026-10-26)

Kyle asked for saved searches on the phone, syncing back when the connection returns.
They follow the notes precedent exactly: `ci.saved_searches` joins the `user_data`
bucket (name, description, query, `entity_types`, `tags`, `filters`, `is_public`,
`share_token`, `is_seed`, timestamps; the sharing posture columns stay server-side),
`POWERSYNC_TABLES` and the PowerSync README list it, and the device schema has a
writable `saved_searches` table (`text[]` and jsonb arrive as JSON text, booleans as
0/1). `connector.ts` replays PUT/PATCH/DELETE through `createSavedSearch` /
`updateSavedSearch` / `deleteSavedSearch`, parsing the JSON-text columns back into the
arrays and object the inputs take; `CreateSavedSearchInput.id` (new, like
`CreateNoteInput.id`) carries the client-minted uuid so the row that syncs back is the
same row. Sharing columns are never written on the device and a PATCH never forwards
them.

On a phone with a replica every saved-search surface reads and writes the local table,
online or off: the Saved Searches page (`LocalSavedSearchesPage`: list, filter, open,
rename, delete; filters are edited in the explorer; sharing is offered only while the
appliance answers), the `?saved_search=` deep link and the loaded-search lookup
(`useSavedSearchById` in `useSavedSearchResolution.ts`), the Load-search picker and
the phone panel's count (`SavedSearchPicker.tsx`), and the explorer's Save / Update
(`SaveSearchButton`, ids minted with uuid v7). The browser keeps GraphQL.

Dev DB: `GRANT SELECT ON ci.saved_searches TO powersync` and `ALTER PUBLICATION
powersync ADD TABLE ci.saved_searches` were run by hand on 2026-10-26 and the
PowerSync container restarted; a fresh `make dev` does both through setup-database.
Phones re-download on the sync-rules change.

Found on the way: `make graphql` was failing on main because
`api/offlineWriteLink.node.test.ts` defined gql-tagged documents codegen validated
(duplicate operation names, an anonymous operation, a made-up `search` shape). They are
`parse()`d now, which keeps them out of the scan.

### Follow-ups outside this plan

- SMS importer: every message has a NULL `thread_id` (19,163 rows), so there
  is no conversation grouping.
- WhatsApp importer: all 5,213 messages share one `thread_id`, the literal
  `whatsapp`.
- After U1: retire `sync_period`, `SyncWindowSweepCron` and the
  `POWERSYNC_TABLES` entries for `events`/`entities`, now unused.

## Goal

Search keeps working on the phone when the appliance is unreachable (no network,
server down, or the user is away from home). Three surfaces have to answer from
data already on the device:

1. The header search box (`GlobalSearchBox`) — suggestions and "search Memory for…".
2. The Memory explorer list (`/memory`) — the page a committed search lands on.
3. The on-device model's `knowledge_search` tool, so an offline chat can still
   answer "when did I last message X" from the phone's own copy.

Writes are out of scope, with one rule added 2026-10-23: while the connection
probe says the appliance is unreachable, a write that would change its database
is refused before it leaves — `fetchJson` / `apiFetch` refuse `POST`/`PUT`/
`PATCH`/`DELETE` aimed at the appliance (`@ci/common` `offlineWrites.ts`), an
Apollo link refuses GraphQL mutations (`apps/web/src/api/offlineWriteLink.ts`),
and the import page's XHR upload asks the same guard first. Every refusal opens
one dialog (`OfflineWriteDialog`) that says to wait for the server. Exempt:
notes (they write the synced `notes` table and replay through the PowerSync
connector), captures (queued in `memoryUploadQueue.ts` / the Local Hub outbox),
position uploads, and the sign-in / session paths that have to work to get
connected at all.

## What is already there (verified 2026-10-19)

**The PowerSync mirror exists and nobody reads it.** `PowerSyncProvider` opens
`ci-powersync.db` (Capacitor SQLite on native, WASQLite/IndexedDB on web) and
syncs seven tables: `notes`, `files` (metadata), `tags`, `threads`, `messages`,
`events` (30-day window via `sync_period`) and `entities` restricted to
`entity_type = 'Event'` so events have names. Only the Settings "On-device
working set" card touches it. A first full sync measured 71 s and 1.2 GB for
~500k rows (events + their entity rows + files); the PowerSync oplog keeps a
second copy of every row, which is most of that.

**Every search path goes to the appliance.** `useSearchService` and the
explorer's `useEntityService` both issue the GraphQL `search` query; offline they
surface an Apollo network error. The on-device model's `knowledge_search` is an
MCP `tools/call` to `/api/mcp` on both platforms (`CompanionIntentClient.kt`,
`CompanionIntentClient.swift`), and the tool list itself comes from
`GET /api/intents?tier=local` at model load. Offline, the manifest fetch fails
and the model loads with **no tools at all**.

**The server has no text projection to sync.** `ci_search.vectors` stores only a
`tsvector` (369 MB, 700k rows), which cannot be rendered back into text.
`ci.entities.search_content` is empty on every row. The one user-scoped text that
exists for every type is `ci.entities.name` / `description` — all 600k active
rows together hold about 25 MB of text. `ci.communications` (206k rows, 21 MB
of `content`, 108 bytes average) and `ci.content` (135k) are both fully
user-scoped (zero NULL `user_id`), contrary to the stale "ci.content (NULL
user_id)" note in `sync-rules.yaml`.

**FTS5 is available on every target.** Android's `sqlcipher-android` AAR
(4.14.1 in the Gradle cache) is built with `SQLITE_ENABLE_FTS5` (checked with
`strings` on `libsqlcipher.so`). The web `wa-sqlite` wasm bundles contain the
fts5 module. iOS uses the SQLCipher pod, which ships FTS5 in every 4.x release;
confirm on the Mac at the first Xcode build. `@powersync/capacitor` 0.5.3 still
has no encryption, so the file is plain SQLite, which is also what lets native
code open it.

**Connection mode already has the hook.** `useConnectionMode` resolves
`connected | local | cached | fresh`; `cached` is a documented TODO waiting for
"a durable local cache that holds data". The documents table below is that signal.

**Dev stack.** The `powersync` compose service is staging/production only; on
this machine it runs from a scratch overlay on host port 18080 (Caddy owns 8080)
and the container is up right now. Every event row on dev still has a
`sync_period` because `SyncWindowSweepCron` (worker role, 03:40) has never run
here.

## Design

### 1. Server: one search-document projection, synced as-is

Add `ci_search.mobile_search_documents`, maintained next to `ci_search.vectors` by the same
write path, so "what text represents this row" stays defined once
(`search-ingress/searchTexts.ts`):

| column | from |
|---|---|
| `id` (uuid, PK) | the `ci_search.vectors` row id — PowerSync needs a text `id` and `(entity_type, entity_id)` is the natural key |
| `entity_type`, `entity_id`, `user_id` | as `vectors` |
| `title` | the weight-A text (name / subject / filename / preview) |
| `body` | weights B–D joined, truncated to 1 KB |
| `occurred_at` | the row's own time, the same `CASE` as `entityTimeSql()` in `SearchService` (sent time, start time, taken-at…) |
| `kind` | a small enum the device can render an icon and a route from (`communication`, `event`, `content`, `file`, `note`, `person`, `place`, `item`, `thread`) |
| `created_at`, `updated_at` | |

`VectorService.upsert` writes both rows in one statement (CTE); `remove`
deletes both. `answer`, `position` and `message` are never projected (the first
two have no text worth a row, the third is the chat recall channel).
`browser-activity` and `file-chunk` were in that list until 2026-10-23 — see
"Browser visits and document excerpts" above. Backfill = bump the type's index
vector stage version in `pipeline/versions.ts` (the existing reindex trick),
or for a type without a stage, the maintenance sweep's lane, not a data
migration.

Sync: one bucket query `SELECT … FROM ci_search.mobile_search_documents WHERE user_id =
bucket.user_id`, the table added to `POWERSYNC_TABLES` in
`infrastructure/setup-database/entrypoint.sh` and a client `Table` in
`api/powersync/schema.ts`. No window: 25 MB of text is cheap and search is the
one place "the last 30 days" is wrong by design. The existing `events` window is
untouched.

### 2. Device: a raw table and an external-content FTS5 index, shared by two readers

`mobile_search_documents` is a PowerSync **raw table** (2026-10-20): the app
creates the SQLite table itself (`api/powersync/searchIndex.ts`) and the sync
client writes it with an explicit upsert / delete / clear, declared on the
schema with `withRawTables`. PowerSync's managed tables keep every row as a
JSON blob in `ps_data__<table>` behind a view — a second copy of the text and a
`json_extract` per read. The raw table stores columns as columns, drops the
three synced columns nothing on the device reads (`user_id`, `created_at`,
`updated_at`), and the index over it is *external-content* FTS5, which stores
only the inverted index and reads the text back by rowid:

```sql
CREATE TABLE IF NOT EXISTS mobile_search_documents (id TEXT PRIMARY KEY NOT NULL, entity_type, entity_id, title, body, occurred_at);
CREATE VIRTUAL TABLE IF NOT EXISTS mobile_search_documents_fts
  USING fts5(title, body, content='mobile_search_documents', tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO mobile_search_documents_fts(mobile_search_documents_fts) VALUES ('rebuild');
-- the three FTS5 external-content triggers on mobile_search_documents keep it current
```

The `put` is `INSERT … ON CONFLICT(id) DO UPDATE`, not `INSERT OR REPLACE`:
REPLACE re-inserts the row under a new rowid and skips the delete trigger, which
would leave the index pointing at rowids that no longer exist. The table must
exist before `connect()` (the first `put` fails otherwise), so the provider
gates connecting on `ensureDocumentsTable`, which also adopts rows PowerSync
parked in `ps_untyped` for a replica built while the table was still managed —
no re-download on the switch. The triggers live in the database, so the web
app, the Kotlin tool and the Swift tool all read one index; a native reader
needs FTS5 and nothing else. Ranking is `bm25()`, with prefix terms (`word*`)
standing in for Postgres' English stemming. Filters mirror the lean
`knowledge.search` form exactly: `entityTypes`, `since`, `until`,
`sort: recent`, `countOnly`.

### 3. Web app: fall back, and say so

- `api/powersync/localSearch.ts`: query → rows shaped like the
  `SearchResultType` union members the box's fragments read (`id` as a
  `GlobalUID`, `__typename`, `title` / `preview` / `filename` / `name`, `time` /
  `startTime`). The box's result rows then render unchanged and navigation keeps
  working.
- `useSearchService`: when `useConnectionMode().mode !== 'connected'`, **or** the
  GraphQL request fails with a network error, answer from `localSearch` and mark
  the result `source: 'device'`. The dropdown shows one caption row, "From this
  phone", so a stale answer is never mistaken for the appliance's.
- Explorer list (`/memory`): the grid fragments need preview URLs, players and
  tags that do not exist offline, so the offline explorer is a plain list view
  (`LocalListView`: icon, title, kind, time, infinite scroll) chosen by the same
  condition, not the full grid with holes in it.
- `connectionMode.ts`: `cached` when `mobile_search_documents` has rows.
- Settings copy on the working-set card: "…and a searchable index of everything".

### 4. Native: the model searches the phone

- **Android** `LocalSearchTool` (Kotlin, `capacitor-local-llm`): opens
  `context.getDatabasePath("ci-powersync.dbSQLite.db")` read-only through the
  bundled SQLCipher driver (empty key), runs the same FTS query, and returns the
  **same JSON shape** `knowledge.search` returns, so `ToolResultShaper` and the
  phone instruction need no change. Bound whenever the appliance's manifest
  cannot be fetched (hand-written declaration, same lean schema), and preferred
  over the appliance call while the connection mode is not `connected`.
- **iOS** `SearchMemoryTool.run`: same decision; a `LocalSearch.swift` over the
  file in `Library/LocalDatabase` using the SQLCipher pod already linked.
- Links under an on-device answer come from the tool rows (title + route),
  never from the model (see the "cannot copy links" finding).

### 5. Dev plumbing (first, because everything above needs it)

- Put `powersync` in the `local` compose profile behind `POWERSYNC_URL` being
  set, publishing `127.0.0.1:18080`, with the overlay's env derivation moved into
  `scripts/dev-stack`. Today the only way to run it is a file that lives in a
  session scratchpad.
- `yarn android` reverses the PowerSync port alongside 5173.

## Phases

| # | Deliverable | Touches |
|---|---|---|
| P0 | PowerSync in `make dev`; sweep cron verified on the worker | compose, `scripts/dev-stack`, `yarn android` |
| P1 | `ci_search.mobile_search_documents` + sync + FTS5 + header box fallback (+ count, recent) | migration, `VectorService`, sync rules, `schema.ts`, `localSearch.ts`, `useSearchService` |
| P2 | ~~Android + iOS local `knowledge_search`, bound when offline~~ → U6 in [Revision 2026-10-21](#revision-2026-10-21-one-device-record-per-entity) | `capacitor-local-llm`, iOS `LocalLLM/` |
| P3 | ~~Offline explorer list, `cached` mode, Settings copy~~ → U3 (`cached` already landed in P1) | `MemoryPage`, `connectionMode.ts` |
| P4 | ~~Offline detail pages for synced types (note, event, thread, file metadata)~~ → U4 (one record page for every type) and U5 (notes) | — |

P1 is the one that proves the shape; P2 and P3 are independent of each other
once P1 lands.

## Decisions needed

1. **People and places on the device.** `nativeDatabase.ts` carries a gate
   ("G-2: no health, location or contacts in this replica until the adapter
   encrypts"). The projection would carry a person's *name* and a place's *name*
   only, no birth dates, coordinates or dossiers; Android's app-private storage
   and iOS Data Protection encrypt the file at rest. Recommendation: include
   names, and reword the gate to say what is and is not in the file.
2. **Window.** All history for documents (~25 MB text, likely 150–300 MB on
   disk with the FTS index and oplog) versus the events' 30-day window.
   Recommendation: all history, since a search that silently stops at 30 days
   is worse than none.
3. **How the fallback surfaces.** Automatic with a "From this phone" caption
   (recommended), or an explicit toggle the user flips.

## Risks and things to measure

- **Index build on first sync — measured, and it hurt.** With the triggers in
  place before the download, PowerSync's checkpoint apply on the S23U fired
  them for each of 582k document rows and crawled at ~200 KB/s of WAL, the
  plugin thread pinned at 100% for over half an hour, every other plugin call
  queued behind the one long write. `ensureSearchIndex` now waits for
  `waitForFirstSync` on a device that has never synced and builds the index
  afterwards in one bulk `INSERT … SELECT`; a device that already synced
  builds at once. A sync-rules change on a device that already carries the
  triggers still goes through them (rare; slow, not wrong). Measured on the
  same phone with a fresh replica on the new path: 1.07 GB / ~1.45M ops
  downloaded in ~4 min, checkpoint applied in ~12 min, index built, 589,395
  documents and 589,395 FTS rows, a real `MATCH` answering in the box — about
  17 min end to end versus an apply that was still running after 50.
- **A page reload mid-write leaves the replica locked (2026-10-23).** The app
  process outlives a WebView page reload (a Vite full reload in dev; rare in
  production). The old page's write connection, if a transaction was open on
  it, stays open natively with that transaction and so with SQLite's WAL
  writer lock; the plugin's JS-side `closeConnection` never reached it because
  the new page's wrapper starts with an empty map. PowerSync's startup then hit
  SQLITE_BUSY, and a database whose startup failed rethrows that from every
  later call, so every offline view showed the error state — with the offline
  wording "Needs the Memory server", which pointed at the wrong thing. Fixes:
  `encryptedInit` now asks the plugin directly to close both connections by
  name before creating its own; `openReplicaWithRetry` (nativeDatabase.ts)
  waits for startup and retries SQLITE_BUSY over ~30 s, then throws
  `ReplicaLockedError`; each attempt is bound as soon as it is constructed and
  unbound when it fails, the binding is a store (`useReplicaDatabase`) so the
  views re-render when it changes, and the error states read a
  `ReplicaOpenState` to say "Opening this phone's copy" / "Couldn't open this
  phone's copy" instead of blaming the server. A leaked handle from before
  these fixes is freed only by a process restart.
- **Write amplification during an import.** Every index write now also replicates
  one document row; the index queue already runs at thousands of rows a minute
  during a big import. PowerSync batches, but watch the replication slot lag.
- **`@powersync/capacitor` `execute()` on Android** treats anything not starting
  with `select` as a statement, which is right for `CREATE VIRTUAL TABLE` and
  triggers; `RETURNING` does not work there, and nothing here needs it.
- **Tokenization parity — closed 2026-10-23.** The text index now uses FTS5's
  `porter` stemmer over `unicode61` (`DOCUMENTS_FTS_TOKENIZER`), so "meetings"
  and "meeting" match the same rows (2,234 each on the S23U), as Postgres'
  `english` configuration (Snowball English) does; prefix matching stays, over
  stems. `ftsMatchExpression` also drops Postgres' English stopword list unless
  the query is nothing else. Because FTS5 allows one tokenizer per table and
  Porter would rewrite the hex groups of a person id (two ids could then
  collide in the Who filter), the id columns moved to a second index,
  `mobile_search_people_fts`, unstemmed; `localList.ts` drives a browse from it
  and probes it by rowid behind a text query. The tokenizer and the trigger text
  are part of the shape `hasSearchIndex` checks, and a rebuild drops the
  triggers before the tables: triggers sit on the documents table, so dropping
  the index left old ones that still named the id columns, and every write
  failed until they were replaced. Porter and Snowball English still differ on
  a few endings.
- **Tokenization parity (original note).** Postgres stems ("running" → "run"); FTS5 unicode61
  does not. Prefix matching narrows the gap; a query that finds something on the
  appliance and nothing on the phone is the acceptance test to write.
- **Two processes, one file.** The web view's PowerSync connection holds the
  file in WAL mode; the native tool opens a second read-only connection. That is
  a supported SQLite configuration, but the native side must never write.
