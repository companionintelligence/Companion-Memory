-- migrate:up

-- Two things the BlueBubbles config row promised and could not deliver:
-- that there is exactly one of it, and that exactly one sync pass runs at a
-- time.
--
-- SINGLETON. `BlueBubblesConfigService.getOrCreate` is a check-then-insert with
-- nothing behind it, so two callers that miss each other by a millisecond mint
-- two rows with two different webhook secrets — after which the one a caller
-- gets is whichever the planner returns, and a webhook signed with the loser's
-- secret is rejected as a 404 forever. An unauthenticated webhook probe reached
-- that insert too (it ran BEFORE the secret check), so an outsider could create
-- the row. The index below makes the second insert fail instead of succeed;
-- `(id IS NOT NULL)` is the expression because it is immutable and constantly
-- true, so the index holds one entry for the whole table.
--
-- Existing duplicates are collapsed to the OLDEST first. That is not an
-- arbitrary pick: `getOrCreate` orders by `created_at ASC LIMIT 1`, so the
-- oldest row is the one every reader already resolves to, and keeping any other
-- would silently swap the connection settings and the webhook secret out from
-- under a working install.
DELETE FROM ci.bluebubbles_config c
 WHERE c.id <> (SELECT id FROM ci.bluebubbles_config ORDER BY created_at ASC, id ASC LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS bluebubbles_config_singleton_uq
    ON ci.bluebubbles_config ((id IS NOT NULL));

COMMENT ON INDEX ci.bluebubbles_config_singleton_uq IS
  'At most one config row, appliance-wide. Enforced here rather than by getOrCreate alone, which is a check-then-insert: two rows means two webhook secrets and a nondeterministic winner.';

-- THE SYNC CLAIM. `BlueBubblesSyncCron` guarded concurrency with a `private
-- running` instance field, which is per-PROCESS — and both the api and the
-- worker run the cron, each with its own copy, so every tick started two passes
-- (25 runs in two hours on a live appliance). The settings page's "Sync now"
-- called `runSync()` bare, so two clicks made four concurrent full-history
-- passes. All of them then pushed into the shared `ci.*` tables at once, which
-- is exactly the untested dedup path `IMPORT_STAGE_CONCURRENCY.push = 1` exists
-- to prevent.
--
-- A shared claim in the database is the only guard that spans processes. The
-- shape is the one `ImportRunService.startRun` uses for a staged upload: a
-- CONSTRAINED UPDATE is the race guard, and the loser learns it lost by
-- affecting no rows.
--
-- The claim is HEARTBEAT-held rather than held outright, for the same reason
-- `import_stages` claims are: a process killed mid-pass would otherwise own the
-- connector forever, and there is no operator surface to break the lock. A live
-- pass refreshes `sync_heartbeat_at` on a timer, so silence past the staleness
-- window means the holder is gone, whoever it was.
ALTER TABLE ci.bluebubbles_config
    ADD COLUMN IF NOT EXISTS sync_claim_token  TEXT,
    ADD COLUMN IF NOT EXISTS sync_heartbeat_at TIMESTAMPTZ;

COMMENT ON COLUMN ci.bluebubbles_config.sync_claim_token IS
  'Opaque token of the pass currently syncing, or NULL. Held across processes: the cron runs in both api and worker, and "Sync now" adds more.';
COMMENT ON COLUMN ci.bluebubbles_config.sync_heartbeat_at IS
  'Last sign of life from the claim holder. A claim silent past the staleness window is stealable — otherwise a killed process owns the connector until someone edits the table.';

-- migrate:down

DROP INDEX IF EXISTS ci.bluebubbles_config_singleton_uq;

ALTER TABLE ci.bluebubbles_config
    DROP COLUMN IF EXISTS sync_claim_token,
    DROP COLUMN IF EXISTS sync_heartbeat_at;
