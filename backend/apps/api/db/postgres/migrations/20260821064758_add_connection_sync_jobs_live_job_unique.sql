-- migrate:up
-- One live sync job per connection endpoint and iteration type, enforced by the
-- database rather than by whoever looked first.
--
-- `SyncOrchestrator.orchestrateSyncJobs` decided whether to create a job by
-- reading the endpoint's history and then, in a separate statement, inserting —
-- with nothing in between. Two overlapping ticks (the cron had no overlap guard,
-- and a second replica would not be stopped by one anyway) could both read "no
-- live job" and both insert one, and `SyncNowService.enqueueForUser` races the
-- cron the same way from an HTTP request. The duplicate is not cosmetic: each
-- copy is dispatched independently, so the provider is fetched twice and the
-- same page transformed twice.
--
-- Partial, on exactly the live states. A connection endpoint accumulates an
-- unbounded history of `success` and `failed` rows — that is the point of the
-- table — so a full unique index would forbid the history instead of the
-- duplicate. `status` is not an index column: the predicate has already fixed it
-- to one of two values.

-- Existing duplicates first, or the CREATE fails on the appliance rather than in
-- review. Only the newest live row per key survives; the rest are marked failed,
-- which is the same terminal state `orchestrateSyncJobs` gives a job it gives up
-- on, and leaves an error a human can read. Nothing is deleted.
UPDATE ci_etl.connection_sync_jobs AS job
   SET status = 'failed',
       completed_at = COALESCE(job.completed_at, now()),
       updated_at = now(),
       error = COALESCE(job.error, '{}'::jsonb)
              || jsonb_build_object('error', 'Superseded duplicate live sync job')
  FROM (SELECT id,
               row_number() OVER (PARTITION BY connection_id, endpoint_name, type
                                      ORDER BY updated_at DESC, id DESC) AS rank
          FROM ci_etl.connection_sync_jobs
         WHERE status IN ('pending', 'in_progress')) AS ranked
 WHERE job.id = ranked.id
   AND ranked.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS connection_sync_jobs_live_job_idx
    ON ci_etl.connection_sync_jobs (connection_id, endpoint_name, type)
    WHERE status IN ('pending', 'in_progress');

-- migrate:down
DROP INDEX IF EXISTS ci_etl.connection_sync_jobs_live_job_idx;
