# Ingest reset runbook

How to wipe all bulk-ingested data and re-import from scratch (e.g. to re-test
an importer change against a clean database). Companion to the
[bulk load runbook](BULK_LOAD_RUNBOOK.md); the provenance-triple idempotency
referenced below is explained in
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

That path is literal **against the API host**. `main.ts` sets no global prefix
and the edge proxy strips a browser's `/api`, but `MaintenanceController` bakes
`api/` into its own path (`@Controller('api/maintenance')`), so pointing `curl`
at the proxy host would strip the prefix you just typed. Use the API's own
host:port.

Only an administrator can run it (`ApplianceAdminGuard`, which lets anyone
through while the appliance is still unclaimed), and an api key needs `full`
capability.

In a single transaction it first locks every table it is about to clear (`LOCK
TABLE ... IN ACCESS EXCLUSIVE MODE`, with a 15 second `lock_timeout`; if the
locks don't come in time the call answers `409` and changes nothing), then runs
one `EXISTS` probe per user-scoped table (`assertNobodyElsesData` in
`IngestResetService`). If any of them still holds a row belonging to a
different account, the call is refused with a `403` naming the tables, because
a `TRUNCATE` cannot take just your rows. On a box with other accounts' data, do
the reset directly against the database instead. The probe covers the
dependent tables below as well as the ingest tables and the search index.

It then:

| What | Why |
|------|-----|
| `TRUNCATE ci.events, ci.communications, ci.content, ci.browser_activity, ci.object_observations, ci.receipt_line_items, ci.receipts, ci.objects, ci.product_models, <dependents> RESTART IDENTITY` | the bulk-ingest destination tables (`INGEST_TABLES` in `IngestResetService`). One statement, not a delete loop: `ci.objects` and `ci.receipt_line_items` reference *each other* (`acquisition_line_item_id` / `minted_object_id`), so no per-table ordering satisfies both. |
| the dependents in that same statement: `ci.files`, `ci.file_chunks`, `ci.message_files`, `ci.unfurls`, `ci.reminders`, `ci.capture_events`, `ci.event_candidates`, `hbpe.content_context`, `hbpe.l1_event_cluster`, `hbpe.l2_content_cluster` | every table with a foreign key into the ingest tables (`DEPENDENT_TABLES`). Postgres will not truncate a referenced table on its own, and the statement has no `CASCADE`, so a foreign key added later makes the reset fail instead of silently emptying one more table. **You lose your uploaded files (the rows; the bytes stay in object storage), their chunks, chat attachments, link previews, every reminder, the capture log and planning candidates.** |
| `DELETE FROM ci.entities WHERE entity_type IN ('Item','Event','Communication') AND linked_table IN ('objects','events','communications') AND owner_user_id = <you>` | the CTI base rows that share a uuid with the truncated detail rows. `TRUNCATE` only follows FKs *pointing at* the truncated tables, so these survive it and would be left as orphan base entities. The `linked_table` predicate is what spares real graph entities, whose `linked_table` is `import:<source>`. |
| `TRUNCATE ci_search.embeddings, ci_search.vectors, ci_search.index_skips` | otherwise the search index is fully orphaned (it points at deleted rows) and skip markers wrongly suppress re-indexing of re-imported rows. The list is shared with `OrphanCleanupService` (`SEARCH_TABLES`) so it cannot drift. |
| re-open your `index.*` rows in `ci.pipeline_state` (`stage_version = 0`) | the index truncate also dropped the entries for your notes, people and messages; the ledger would otherwise still say they are indexed, and neither the pipeline nor the backfill would embed them again |
| `DELETE FROM pgboss.job WHERE name = 'search-index' AND state IN ('created','active','retry') AND data->>'userId' = <you>` | your queued index jobs reference rows that no longer exist; they would drain as pure entity-not-found noise. Jobs that name no account are left to drain as no-ops. |

There is no longer a communications dedup companion table to clear in
lockstep. `ci.communications` stopped being a hypertable in
`20260807072321_dehypertable_communications.sql`, which dropped
`ci.communications_source_dedup`, its `AFTER DELETE` trigger and the bespoke
claim logic in `CommunicationService.createMany`, and put the real key back in
the database as the partial unique index `communications_source_triple_uniq`
on `(user_id, source_type, source_system, source_id)`. A truncate takes that
index with the rows, so the old "0 communications on re-import" failure mode is
gone with it.

Response: `countsBefore` (rows per table at the moment of the reset: the ingest
tables, their dependents and the three `ci_search` tables), `truncated` (table
list), `searchIndexJobsDeleted`, `ledgerRowsReopened`.

## 2. Importer-side watermark reset (legacy CI-Import-Tools only)

CI-Server's own native import domain (`backend/apps/api/src/domains/import/`) is
run-scoped — each import run stages into `ci_import.*` and dies with that run
(`ON DELETE CASCADE`) — so there is no cross-run watermark to reset here; a
fresh import run just starts clean. This step only applies if you are still
reconciling data pushed by an old, retired **CI-Import-Tools** checkout
(`ZARCHIVED-CI-Import-Tools`), which tracked its own progress out-of-band:

The old importer only pushed timeline items newer than its stored cursor — key
`ci_server.last_push` in its SQLite `settings` table (`WATERMARK_KEY` in
`backend/src/ci-server/push.ts`). After a server reset that cursor still points
at the end of the previous push, so the next sync would push **nothing**.

```sql
-- against the old importer's SQLite database
DELETE FROM settings WHERE key = 'ci_server.last_push';
```

(Or use whatever "full re-sync" affordance the old importer UI exposed; that is
what it did under the hood.)

## 3. Verify, re-import, re-enrich

1. `GET /api/maintenance/ingest-status` — all `tables` counts 0, queue empty.
2. Re-run the import (see `BULK_LOAD_RUNBOOK.md` for the high-throughput path).
3. Re-run the post-load enrichment chain, ending with
   `POST /api/maintenance/search-index/backfill`; poll
   `GET /api/maintenance/ingest-status` until the queue drains and
   `embeddingsByType` + `skipsByType` cover the imported rows.
