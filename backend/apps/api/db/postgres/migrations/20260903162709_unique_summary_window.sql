-- migrate:up
-- One row per summarized window, enforced by the database.
--
-- ## The race this closes
--
-- `hourly_summary` checks for an existing exact-window row
-- (`find_existing_summary_activity`) and returns early if it finds one, but
-- `store_summary_activity` was a bare INSERT minting a fresh `summary_id`, and
-- the only index covering the window was `summaries_user_period_idx`, which is
-- NOT unique. Two runs for the same window — the `:05` hourly cron racing an
-- operator's `POST /summary/manual-trigger`, or two runner workers draining a
-- queued backfill — both saw no row and both inserted. The check-then-insert
-- reproduced exactly the duplicate it was added to prevent, and nothing ever
-- repaired the pairs already written: `ORDER BY created_at LIMIT 1` then pinned
-- the OLDEST (often emptiest, generated from a partially-imported hour) row as
-- the permanent answer for that hour.
--
-- With this index in place `store_summary_activity` upserts
-- (`ON CONFLICT ... DO UPDATE`), so the race converges on one row instead of
-- duplicating, and a forced regeneration overwrites the window in place rather
-- than minting a second answer for it.
--
-- ## Why the index is partial
--
-- Insights share this table with `period_type = 'insight'` and deliberately
-- store SEVERAL rows per (user, window) — one row per insight card, written in
-- a loop by `store_insight_activity` over the same
-- `last_insight_time → now` span. A blanket unique index would fail the second
-- card of every insight run. The predicate keeps them out; every period type
-- the rollup/hourly writer produces is covered.
--
-- ## Duplicates already on disk
--
-- A plain CREATE UNIQUE INDEX would fail on any appliance that already raced,
-- so collapse first. The survivor is the most recently created row: for a
-- window that was summarized early from partial data and re-summarized later,
-- the later row is the richer one, which is the opposite of what the buggy
-- `ORDER BY created_at LIMIT 1` read was returning. `created_at` is nullable
-- (DEFAULT NOW(), no NOT NULL), so NULLS LAST keeps an undated row from
-- winning by accident, and `summary_id DESC` breaks exact ties so the delete
-- is deterministic.
--
-- Two of the three dependents follow the FKs they already declare:
-- `ci.feed_queue` rows for a deleted duplicate CASCADE away (the feed should
-- never have shown the same hour twice), and `ci.graph_deltas.summary_id` is
-- SET NULL, which loses only the back-pointer, not the delta.
--
-- The FK list is NOT the dependent list. `hbpe.summary_l1_label.summary_id` is
-- a cross-schema reference with no foreign key at all (its only FK is to
-- `hbpe.l1_clusters`), so nothing in the database cleans it up. It also holds
-- exactly the rows this delete hits: HBPE labels whatever
-- `get_unlabeled_summaries*` returns, and that read had the same
-- `ORDER BY created_at LIMIT 1` bug, so on a raced window it labeled the OLDER
-- row — the one collapsed away below. Left alone, the label row survives
-- pointing at a summary_id that no longer exists, and the survivor comes back
-- as unlabeled anyway.
--
-- Delete those labels rather than re-pointing them at the survivor. A label is
-- Qwen's classification of one row's own `content->>'summary_text'`
-- (`SummaryTokenizer._label_rows`), and the row being dropped is by this
-- migration's own reasoning the partial one; moving its l0_class onto the
-- richer survivor would re-import the classification of the text we just
-- decided to discard, permanently — `get_unlabeled_summaries` skips any
-- summary that has a label and `_store_summary_label` is
-- `ON CONFLICT DO NOTHING`, so nothing ever revisits it. Deleting is
-- self-healing instead: the survivor reads as unlabeled and the next nightly
-- run relabels it from the text that won, at a cost of one Qwen call per raced
-- window, once. It also sidesteps the collision a re-point would hit —
-- `summary_l1_label`'s primary key is `summary_id` alone, so a window where
-- both duplicates got labeled has a row already sitting on the survivor's id
-- and an UPDATE would abort the migration on that appliance.

CREATE TEMP TABLE _raced_summary_windows ON COMMIT DROP AS
SELECT summary_id
  FROM (
      SELECT summary_id,
             row_number() OVER (
                 PARTITION BY user_id, period_type, period_start, period_end
                 ORDER BY created_at DESC NULLS LAST, summary_id DESC
             ) AS rn
        FROM ci.summaries
       WHERE period_type <> 'insight'
  ) ranked
 WHERE ranked.rn > 1;

-- Guarded and dynamic: `hbpe` is the sidecar's schema, and a summary-only
-- appliance that never ran the HBPE migrations has no such table — an
-- unguarded static reference would fail this migration at parse time, before
-- the guard could run.
DO $$
BEGIN
    IF to_regclass('hbpe.summary_l1_label') IS NOT NULL THEN
        EXECUTE $sql$
            DELETE FROM hbpe.summary_l1_label
             WHERE summary_id IN (SELECT summary_id FROM _raced_summary_windows)
        $sql$;
    END IF;
END $$;

DELETE FROM ci.summaries
 WHERE summary_id IN (SELECT summary_id FROM _raced_summary_windows);

-- Not CONCURRENTLY: dbmate runs each migration inside a transaction, and
-- CREATE INDEX CONCURRENTLY cannot run in one.
CREATE UNIQUE INDEX summaries_user_window_uniq
    ON ci.summaries (user_id, period_type, period_start, period_end)
 WHERE period_type <> 'insight';

-- migrate:down
DROP INDEX IF EXISTS ci.summaries_user_window_uniq;
