-- migrate:up
-- hbpe.reserialize_days: the days HBPE has to re-serialize outside its nightly
-- serialize budget.
--
-- WHY. hbpe.token_stream is written only by TokenSerializer.serialize_day,
-- which rewrites one (user, day). The nightly serialize step visits the newest
-- 91 days that hold an event or an hourly summary, plus emptied days that still
-- hold token rows, and the API's change notifications re-serialize today alone.
-- Any other day keeps the rows the last run to select it wrote. On a running
-- appliance that is every day older than the budget: such a day still has its
-- event or summary behind it, so it never becomes an emptied day either.
-- Recurrence reads 180 days of the table, seasonal 800, and HMT training all of
-- it, so a meeting deleted, cancelled or edited on such a day went on counting.
--
-- WHAT. A queue that HBPE owns. Its ingester upserts a row for every past day
-- an event notification names, bumping queued_at on a repeat. The nightly
-- serialize step drains the queue after its own pass. A queued day the pass did
-- not visit and that still holds token rows is rewritten, newest first, at most
-- 91 a night on top of the pass. Every other row is just consumed, and a row is
-- consumed only while its queued_at is still the one the drain read. See
-- backend/apps/hbpe/src/ci/hbpe/pipeline/reserialize_queue.py and bootstrap.md
-- beside it.
--
-- A migration cannot do the rewrite itself. Serialization is HBPE's, and
-- deleting a stale day's token rows here would also delete its live events'
-- tokens, with nothing to write them back.
--
-- DEPLOY ORDER. Either order works. HBPE treats a missing table as no queue (its
-- image can run ahead of this migration), and nothing in the API reads or
-- writes the table.
--
-- user_id cascades like the other per-user hbpe tables (token_stream_rollup,
-- seasonal_profiles); the account purge discovers it from the catalog.
CREATE TABLE IF NOT EXISTS hbpe.reserialize_days (
    user_id    UUID        NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    date       DATE        NOT NULL,
    reason     TEXT        NOT NULL,
    queued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, date)
);

COMMENT ON TABLE hbpe.reserialize_days IS
  'Days whose hbpe.token_stream rows HBPE must rewrite outside its nightly '
  'serialize budget. Written by the HBPE ingester (one row per past UTC day an '
  'event change notification names; a repeat bumps queued_at) and drained by '
  'the nightly serialize step, at most 91 rewrites a night. See '
  'ci/hbpe/pipeline/reserialize_queue.py.';
COMMENT ON COLUMN hbpe.reserialize_days.date IS
  'The UTC calendar day to rewrite, as hbpe.token_stream.date counts it.';
COMMENT ON COLUMN hbpe.reserialize_days.reason IS
  'Why the day was queued: event_changed (a notification), or one of this '
  'migration''s seed reasons: did_not_happen, changed_after_serialize, '
  'labeled_after_serialize.';
COMMENT ON COLUMN hbpe.reserialize_days.queued_at IS
  'When the row was last queued. The drain consumes a row only while this still '
  'equals the value it read, so a day re-queued mid-drain survives to the next '
  'night.';

-- SEED. The days whose tokens can already be shown to be stale, so the first
-- drains rewrite them. A day qualifies when it holds token rows and a LABELED
-- event (the serializer publishes only labeled events) that matches one of:
--
--  * did_not_happen: status cancelled, no_show or skipped, not deleted, not a
--    planned block. Before #2892 HBPE's reads ignored status, so every token
--    row written before it counts such an event. The nightly now rewrites the
--    days in its budget without them, and this reaches the rest. It is the
--    residue query from #2892's description without its `since` bound, which
--    only an operator could supply. A day the nightly has since rewritten is
--    consumed by the drain without a second visit.
--  * changed_after_serialize: updated after the day's last serialization. That
--    covers a soft-delete, a status change, an edit, and an event moved onto
--    the day.
--  * labeled_after_serialize: labeled after the day's last serialization, so
--    its tokens never reached the day.
--
-- It cannot find the day an event was moved OFF, since nothing left on that
-- day changed, or a change that did not touch updated_at. Days are UTC, as the
-- notifications and HBPE's reads count them. A day included needlessly costs
-- one rewrite of an unchanged day, and the drain's cap bounds even that.
--
-- The shape is for the planner. Each token day is one index range scan of
-- ci.events (events_user_time_idx), and each of its events one primary-key
-- probe of hbpe.l1_event_cluster: the LIMIT 1 keeps that probe from being
-- flattened into a join. As a plain JOIN the planner seq-scanned every label
-- once per token day (2.7 s for 92 days on the 198k-event reference corpus,
-- against 0.35 s this way, and the gap grows with both).
INSERT INTO hbpe.reserialize_days (user_id, date, reason)
SELECT td.user_id,
       td.date,
       CASE
           WHEN f.did_not_happen THEN 'did_not_happen'
           WHEN f.changed        THEN 'changed_after_serialize'
           ELSE                       'labeled_after_serialize'
       END
  FROM (
        SELECT ts.user_id, ts.date, max(ts.serialized_at) AS last_serialized
          FROM hbpe.token_stream ts
         GROUP BY ts.user_id, ts.date
       ) td
 CROSS JOIN LATERAL (
        SELECT bool_or(
                   e.is_deleted = FALSE
                   AND e.event_type IS DISTINCT FROM 'planned_block'
                   AND COALESCE(e.status, 'confirmed') IN ('cancelled', 'no_show', 'skipped')
               ) AS did_not_happen,
               bool_or(e.updated_at > td.last_serialized) AS changed,
               bool_or(link.assigned_at > td.last_serialized) AS labeled
          FROM ci.events e
         CROSS JOIN LATERAL (
                SELECT ec.assigned_at
                  FROM hbpe.l1_event_cluster ec
                 WHERE ec.event_id = e.event_id
                 LIMIT 1
               ) link
         WHERE e.user_id = td.user_id
           AND e.start_time >= (td.date::timestamp AT TIME ZONE 'UTC')
           AND e.start_time <  ((td.date + 1)::timestamp AT TIME ZONE 'UTC')
       ) f
 WHERE f.did_not_happen OR f.changed OR f.labeled
ON CONFLICT (user_id, date) DO NOTHING;

-- migrate:down

DROP TABLE IF EXISTS hbpe.reserialize_days;
