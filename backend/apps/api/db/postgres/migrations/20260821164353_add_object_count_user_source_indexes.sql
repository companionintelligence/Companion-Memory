-- Serve the picker's per-source object counts (ObjectCountService) without a
-- sequential scan of the whole table on every wizard open.
--
-- Four of the six tables ObjectCountService.countsForUser groups by
-- (user_id, source_system) have no index that starts with those two columns:
-- each one's only source-scoped index is the `(user_id, source_type,
-- source_system, source_id) WHERE source_id IS NOT NULL` idempotency
-- constraint — a PARTIAL index the aggregate's plain `WHERE user_id = $1`
-- query cannot use, because nothing in that query implies `source_id IS NOT
-- NULL`. Relying on "every row happens to have a source_id today" to make the
-- partial index usable would be exactly the kind of guard-narrower-than-the-
-- bug fragility this codebase's own import-ETL post-mortems warn about — a
-- future row minted without one would silently vanish from an index-only
-- scan rather than fail loudly. These are plain, non-partial, so the
-- aggregate's correctness never depends on source_id's nullability.
--
-- `ci.events` and `ci.receipts` are indexed too: events because its own
-- COUNT-serving index (events_source_idx) leads with `source_type`, not
-- `user_id`, so a caller-scoped query still has to walk every user's rows for
-- a matching source_type before it can filter down; receipts is included for
-- symmetry even though it is small today (a few hundred rows on this
-- appliance) — cheap to build, and it stops the table from becoming the one
-- unindexed straggler the day a household imports years of orders.
--
-- ci.position and ci.content already have what this needs:
-- `position_source_triple_idx`/`content_source_triple_uniq` are the same
-- partial shape as the others, but ci.content is additionally covered by
-- content_user_id_time_idx's leading (user_id) column being selective enough
-- in EXPLAIN against this session's 104k-row table (24ms) that a dedicated
-- index was not worth the write overhead; re-measure if that table grows
-- materially past this appliance's current corpus.
--
-- Not built CONCURRENTLY: dbmate wraps this migration in a transaction (which
-- CONCURRENTLY cannot run inside) and migrate-database gates api startup, the
-- same tradeoff `pipeline_dead_letters_replayed_idx`'s migration documents.
-- EXPLAIN ANALYZE against this session's live tables (325k communications,
-- 199k events, 255k browser_activity rows, single user) put every affected
-- query at 25-90ms even as a full parallel sequential scan — comfortably fast
-- enough that the blocking build is the right tradeoff here; an appliance
-- with a materially larger corpus should rebuild these CONCURRENTLY out of
-- band instead of relying on this migration's lock duration.

-- migrate:up
CREATE INDEX IF NOT EXISTS communications_user_source_idx
  ON ci.communications (user_id, source_system);

CREATE INDEX IF NOT EXISTS events_user_source_idx
  ON ci.events (user_id, source_system)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS browser_activity_user_source_idx
  ON ci.browser_activity (user_id, source_system);

CREATE INDEX IF NOT EXISTS receipts_user_source_idx
  ON ci.receipts (user_id, source_system);

COMMENT ON INDEX ci.communications_user_source_idx IS
  'Serves ObjectCountService''s per-user, per-source GROUP BY (Mail/Messages/Conversations/Posts). Deliberately non-partial — see the migration header for why the existing source-triple index cannot serve this query.';

COMMENT ON INDEX ci.events_user_source_idx IS
  'Serves ObjectCountService''s per-user, per-source GROUP BY (Calendar/Places/Health/Trips/Listening/Posts). Partial on is_deleted, matching the aggregate''s own filter — a soft-deleted event is never counted.';

COMMENT ON INDEX ci.browser_activity_user_source_idx IS
  'Serves ObjectCountService''s per-user, per-source GROUP BY (Browsing).';

COMMENT ON INDEX ci.receipts_user_source_idx IS
  'Serves ObjectCountService''s per-user, per-source GROUP BY (Orders & payments).';

-- migrate:down
DROP INDEX IF EXISTS ci.communications_user_source_idx;
DROP INDEX IF EXISTS ci.events_user_source_idx;
DROP INDEX IF EXISTS ci.browser_activity_user_source_idx;
DROP INDEX IF EXISTS ci.receipts_user_source_idx;
