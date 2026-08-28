-- migrate:up
-- `ci_etl.connection_sync_jobs` shipped with a UUID primary key and nothing
-- else — `SELECT indexname FROM pg_indexes WHERE tablename =
-- 'connection_sync_jobs'` returned exactly one row, `connection_sync_jobs_pkey`
-- — so every predicate below was a sequential scan over a table that only ever
-- grows (its single DELETE is a per-id GraphQL mutation). The scans are driven
-- by the busiest polling loops on the appliance: `SyncOrchestrator`
-- `executeSyncJobs` every 30 seconds, `orchestrateSyncJobs` and
-- `executeTransformJobs` every minute.
--
-- The three indexes are derived from the shapes those loops and `SyncNowService`
-- issue, not from the column list. Two conventions run through all of them:
--
--  * Every column is ascending. A btree scans backwards, so one index serves
--    both `ORDER BY updated_at ASC` and `DESC`, and the entity's `@Index`
--    decorators — which cannot express a per-column direction — restate the
--    migration exactly rather than approximately.
--  * Every index ends in `id`, because every ordered read does:
--    `ConnectionSyncJobService.search` appends the primary key to the sort to
--    make it total, and the two hand-written queries carry the same tiebreak.
--    Without the column the tiebreak costs a sort on top of the scan.

-- `orchestrateSyncJobs` runs this twice per connection × active endpoint, once
-- per minute (`... WHERE user_id = $1 AND connection_id = $2 AND endpoint_name
-- = $3 AND type = $4 ORDER BY updated_at DESC, id DESC`), and
-- `SyncNowService.enqueue` runs the same shape without `type`.
--
-- `type` is deliberately not in the index. It holds two values
-- ('incremental' / 'historical'), so it prunes almost nothing, and leaving it
-- out keeps `updated_at` adjacent to the equality columns — which is what makes
-- this index serve the sort for BOTH callers rather than only the one that
-- filters on type. `user_id` is likewise a recheck: a connection belongs to one
-- user, so `connection_id` has already selected the user's rows.
CREATE INDEX IF NOT EXISTS connection_sync_jobs_endpoint_recent_idx
    ON ci_etl.connection_sync_jobs (connection_id, endpoint_name, updated_at, id);

-- The live-work index. Four readers, all of them on a timer or on the
-- sync-now request path:
--
--   `findDispatchablePending`  DISTINCT ON (connection_id) ... WHERE status =
--                              'pending' AND NOT EXISTS (... connection_id = ?
--                              AND status = 'in_progress')
--                              ORDER BY connection_id, updated_at, id
--   `countInProgress`          WHERE status = 'in_progress' LIMIT ?
--   `userHasActiveSyncPipeline` WHERE user_id = ? AND status IN each of the two
--   `search({ status })`       WHERE status = ? ORDER BY updated_at, id
--
-- `connection_id` sits between `status` and `updated_at` for the first of them:
-- with `status` fixed by an equality the index order IS the `DISTINCT ON` sort,
-- so the oldest pending job per connection comes off the scan directly, and the
-- correlated `NOT EXISTS` becomes a lookup on the same index's
-- `(status, connection_id)` prefix. The plain `status`-only readers pay a sort
-- over what is left, which is the whole point of the next paragraph: there is
-- almost nothing left.
--
-- Partial, because the selectivity is in the predicate and not in the column:
-- `pending` and `in_progress` are transient, while every row the appliance has
-- ever synced settles into `success` or `failed` and stays there forever. A full
-- index on `status` would carry that entire history to answer a question only
-- ever asked about the handful of live rows.
CREATE INDEX IF NOT EXISTS connection_sync_jobs_active_idx
    ON ci_etl.connection_sync_jobs (status, connection_id, updated_at, id)
    WHERE status IN ('pending', 'in_progress');

-- The transform sweep: `executeTransformJobs` every minute, and the third leg of
-- `userHasActiveSyncPipeline` (`WHERE status = 'success' AND last_transformed IS
-- NULL ORDER BY updated_at DESC, id DESC`).
--
-- The most selective predicate on the table and so the strongest case for a
-- partial index: a successful sync is untransformed only in the window between
-- its fetch and its transform, so this indexes a queue rather than a history.
-- `status` is not an index column — the predicate has already fixed it — which
-- leaves `updated_at` leading and the sort answered by the scan.
--
-- The claim itself (`ConnectionSyncJobService.claimTransform`, `UPDATE ... WHERE
-- id = $1::uuid AND last_transformed IS NULL AND (transform_claimed_at IS NULL
-- OR transform_claimed_at < now() - interval '1 hour') RETURNING id`) needs
-- nothing added: it is keyed on `id`, so the primary key resolves it to one row
-- and the remaining conditions are a recheck of that row. Same for
-- `claimPending`.
CREATE INDEX IF NOT EXISTS connection_sync_jobs_untransformed_idx
    ON ci_etl.connection_sync_jobs (updated_at, id)
    WHERE status = 'success' AND last_transformed IS NULL;

-- Considered and not added: an index on `user_id` alone. The only shape that
-- filters on nothing else is `findAll`, which returns the user's entire sync
-- history and paginates it in JavaScript — it reads those rows either way, so
-- the index could only skip other users' rows, and the appliance's own
-- deployment has one user. Every other user-scoped shape carries `connection_id`
-- or `status` and is served above.

-- migrate:down
DROP INDEX IF EXISTS ci_etl.connection_sync_jobs_untransformed_idx;
DROP INDEX IF EXISTS ci_etl.connection_sync_jobs_active_idx;
DROP INDEX IF EXISTS ci_etl.connection_sync_jobs_endpoint_recent_idx;
