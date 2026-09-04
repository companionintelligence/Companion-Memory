-- migrate:up
-- One rollup summary per (user, tier, window), enforced by the database.
--
-- `store_summary_activity` (backend/apps/summary/src/ci/summary/activities.py)
-- minted a fresh uuid and plain-INSERTed. The pg-boss job that dispatches it is
-- retried, and the sidecar reports its outcome over a callback webhook — so a
-- callback that is delivered but lost (worker restart, dropped connection)
-- re-runs a function that already wrote its row, and the user ends up with two
-- summaries for the same hour. They are not cosmetic: `fetch_child_summaries`
-- feeds every hourly row of the window into the daily rollup, so the duplicate
-- is summarised twice and the LLM is billed for it twice.
--
-- PARTIAL, on exactly the tiers that are one-per-window by construction:
-- 'hourly' and the three rollups `functions.py` can produce ('daily', 'weekly',
-- 'monthly'). 'insight' is deliberately excluded — `store_insight_activity`
-- writes one row *per insight* over a single window, so a unique index would
-- keep only the last of them. 'seasonal' and 'yearly' are accepted by the
-- period_type check constraint but nothing writes them yet; constraining a
-- cadence before it exists just pre-judges what its window means.

-- Existing duplicates first, or CREATE UNIQUE INDEX fails on the appliance
-- rather than in review. Keep the most recently created row per key — it was
-- generated from the most data — and tiebreak on summary_id so exactly one
-- survivor is guaranteed even when two rows share a created_at (the retry
-- window is short enough that they often do). created_at is nullable, and a row
-- without one is not the newest, so NULLS LAST rather than the DESC default.
DELETE FROM ci.summaries AS summary
USING (SELECT summary_id,
              row_number() OVER (PARTITION BY user_id, period_type, period_start
                                     ORDER BY created_at DESC NULLS LAST, summary_id DESC) AS rank
         FROM ci.summaries
        WHERE period_type IN ('hourly', 'daily', 'weekly', 'monthly')) AS ranked
WHERE summary.summary_id = ranked.summary_id
  AND ranked.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS summaries_user_period_unique_idx
    ON ci.summaries (user_id, period_type, period_start)
    WHERE period_type IN ('hourly', 'daily', 'weekly', 'monthly');

-- migrate:down
DROP INDEX IF EXISTS ci.summaries_user_period_unique_idx;
