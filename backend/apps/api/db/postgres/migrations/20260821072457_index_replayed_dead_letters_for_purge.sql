-- Make the replayed half of ci.pipeline_dead_letters cheap to sweep.
--
-- `DeadLetterReaperListener.purgeReplayed` runs on the reaper's own two-minute
-- tick and deletes letters that were successfully re-emitted more than
-- DEAD_LETTER_REPLAYED_RETENTION_DAYS ago. Its predicate is
-- `replayed_at IS NOT NULL AND replayed_at < <cutoff>`, and until now NO index
-- could serve it:
--
--   * pipeline_dead_letters_unreplayed_idx is partial ON (replayed_at)
--     WHERE replayed_at IS NULL — the exact complement of this predicate, so it
--     is unusable here;
--   * pipeline_dead_letters_queue_failed_idx leads with `queue`;
--   * pipeline_dead_letters_user_idx leads with `user_id`.
--
-- Without this index every tick is a sequential scan. That is free on a healthy
-- appliance (the table is empty) and is exactly wrong after the incident that
-- fills it: 720 scans a day over the one table holding hundreds of thousands of
-- verbatim payloads, at the moment the database is least idle.
--
-- Partial for the same reason its `WHERE replayed_at IS NULL` sibling is: the
-- two halves of this table are read by two different code paths, and neither
-- ever wants the other's rows. Partial also means the harvest path — which
-- INSERTs rows with `replayed_at` NULL, thousands at a time during an outage —
-- pays nothing to maintain it. Only a replay adds an entry, and the purge is
-- what takes it away again.
--
-- Ordered ASC (the default) because the purge takes the OLDEST replayed letters
-- first, bounded by a LIMIT: with this index that batch is a forward range scan
-- that stops at the limit rather than a scan of everything past the cutoff.
--
-- Cheap here because the index is built over the replayed rows only; on a large
-- table this belongs out of band as CREATE INDEX CONCURRENTLY, since dbmate
-- wraps migrations in a transaction and migrate-database gates api startup.

-- migrate:up
CREATE INDEX IF NOT EXISTS pipeline_dead_letters_replayed_idx
  ON ci.pipeline_dead_letters (replayed_at)
  WHERE replayed_at IS NOT NULL;

COMMENT ON INDEX ci.pipeline_dead_letters_replayed_idx IS
  'Serves the retention purge: replayed letters, oldest first. Unreplayed letters are deliberately absent — they have no TTL and are never swept.';

-- The table comment has said "these never expire" since the control plane was
-- created. That is still true of an UNREPLAYED letter, and it is the whole
-- reason this table exists; it is no longer true of one that has been replayed,
-- and a comment that overstates the guarantee is how an operator concludes the
-- purge is a bug.
COMMENT ON TABLE ci.pipeline_dead_letters IS
  'Terminal job failures with their payload, kept for replay. An UNREPLAYED letter never expires — the payload is often the only surviving copy of the record. A letter that has been successfully re-emitted (replayed_at IS NOT NULL) is reclaimed by DeadLetterReaperListener.purgeReplayed once it is older than the configured retention window.';

-- migrate:down
DROP INDEX IF EXISTS ci.pipeline_dead_letters_replayed_idx;

COMMENT ON TABLE ci.pipeline_dead_letters IS
  'Terminal job failures with their payload, kept for replay. Unlike pg-boss archive rows these never expire — the payload is often the only surviving copy of the record.';
