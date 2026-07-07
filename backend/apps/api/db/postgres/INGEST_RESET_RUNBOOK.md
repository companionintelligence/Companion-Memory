# Ingest reset runbook

How to wipe all bulk-ingested data and re-import from scratch (e.g. to re-test
an importer change against a clean database). Companion to the
[bulk load runbook](BULK_LOAD_RUNBOOK.md); the dedup-table mechanics referenced
below are explained in
[docs/architecture/Database.md](../../../../../docs/architecture/Database.md#idempotency--dedup-design),
and the full `/api/maintenance/*` surface in
[docs/api/rest.md](../../../../../docs/api/rest.md#maintenance--enrichment--apimaintenance--domainsmaintenancecontrollersmaintenancecontrollerts374).

> **DESTRUCTIVE — all users' ingested data.** Never run this against a database
> whose data you want to keep. There is no partial mode and no undo.

## 1. Server-side reset (one endpoint, one transaction)

```
POST /api/maintenance/ingest/reset
Authorization: ApiKey <key>            # or Bearer <jwt> — same guard as all
Content-Type: application/json         # /api/maintenance/* endpoints

{ "confirm": "RESET_ALL_INGESTED_DATA" }
```

Any other body — missing, `true`, a different string — is a `400` before the
handler runs.

In a single transaction it:

| What | Why |
|------|-----|
| `TRUNCATE ci.events, ci.communications, ci.content, ci.inventory, ci.browser_activity RESTART IDENTITY CASCADE` | the bulk-ingest destination tables |
| `TRUNCATE ci.communications_source_dedup` (same statement) | **required in lockstep** — `TRUNCATE` does not fire the per-row `AFTER DELETE` trigger that normally keeps the dedup table consistent with the hypertable. If the dedup rows survive, every provenance triple in the next re-import "dedupes" against a pointer to a deleted row and the re-import lands **0 communications** (this incident has happened). `CommunicationService.createMany` + migration `20260628120000_communications_source_dedup_table.sql` are the mechanism. |
| `TRUNCATE ci_search.embeddings, ci_search.vectors, ci_search.index_skips` | otherwise the search index is fully orphaned (it points at deleted rows) and skip markers wrongly suppress re-indexing of re-imported rows. The list is shared with `OrphanCleanupService` (`SEARCH_TABLES`) so it cannot drift. |
| `DELETE FROM pgboss.job WHERE name = 'search-index' AND state IN ('created','active','retry')` | queued index jobs reference rows that no longer exist; they would drain as pure entity-not-found noise |

Response: `countsBefore` (rows per table at the moment of the reset),
`truncated` (table list), `searchIndexJobsDeleted`.

## 2. Importer-side watermark reset (CI-Import-Tools)

The importer only pushes timeline items newer than its stored cursor — key
`ci_server.last_push` in its SQLite `settings` table (`WATERMARK_KEY` in
`backend/src/ci-server/push.ts`). After a server reset that cursor still points
at the end of the previous push, so the next sync would push **nothing**.

```sql
-- against the importer's SQLite database
DELETE FROM settings WHERE key = 'ci_server.last_push';
```

(Or use whatever "full re-sync" affordance the importer UI exposes; that is
what it does under the hood.)

## 3. Verify, re-import, re-enrich

1. `GET /api/maintenance/ingest-status` — all `tables` counts 0, queue empty.
2. Re-run the import (see `BULK_LOAD_RUNBOOK.md` for the high-throughput path).
3. Re-run the post-load enrichment chain, ending with
   `POST /api/maintenance/search-index/backfill`; poll
   `GET /api/maintenance/ingest-status` until the queue drains and
   `embeddingsByType` + `skipsByType` cover the imported rows.
