# Mobile local search — plan

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Status: 2026-10-19, branch `mobile-local-search`. Phases 0, 0.5 and 1 below are
implemented on the branch (uncommitted); 2, 3 and 4 are not started.

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

## Goal

Search keeps working on the phone when the appliance is unreachable (no network,
server down, or the user is away from home). Three surfaces have to answer from
data already on the device:

1. The header search box (`GlobalSearchBox`) — suggestions and "search Memory for…".
2. The Memory explorer list (`/memory`) — the page a committed search lands on.
3. The on-device model's `knowledge_search` tool, so an offline chat can still
   answer "when did I last message X" from the phone's own copy.

Writes are out of scope: notes already replay through the PowerSync connector,
captures already queue in the Local Hub outbox.

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
deletes both. Types the global box already hides (`answer`, `browser-activity`,
`position`, `file-chunk`, `message`) are never projected. Backfill = reset the
index vector stage's `stage_version` (the existing reindex trick in
`OrphanCleanupService`), not a data migration.

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
| P2 | Android + iOS local `knowledge_search`, bound when offline | `capacitor-local-llm`, iOS `LocalLLM/` |
| P3 | Offline explorer list, `cached` mode, Settings copy | `MemoryPage`, `connectionMode.ts` |
| P4 | Offline detail pages for synced types (note, event, thread, file metadata) | later |

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
- **Write amplification during an import.** Every index write now also replicates
  one document row; the index queue already runs at thousands of rows a minute
  during a big import. PowerSync batches, but watch the replication slot lag.
- **`@powersync/capacitor` `execute()` on Android** treats anything not starting
  with `select` as a statement, which is right for `CREATE VIRTUAL TABLE` and
  triggers; `RETURNING` does not work there, and nothing here needs it.
- **Tokenization parity.** Postgres stems ("running" → "run"); FTS5 unicode61
  does not. Prefix matching narrows the gap; a query that finds something on the
  appliance and nothing on the phone is the acceptance test to write.
- **Two processes, one file.** The web view's PowerSync connection holds the
  file in WAL mode; the native tool opens a second read-only connection. That is
  a supported SQLite configuration, but the native side must never write.
