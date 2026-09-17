-- migrate:up
-- Remove the search-index rows the embed pipeline wrote for planned blocks.
--
-- ## The bug (fixed forward in the same change as this migration)
--
-- ci.events guardrail #2 (docs/architecture/planning-roadmap.md) says a
-- `planned_block` row is never indexed: "index the task, not the block". The
-- event-driven path honoured it — EventSearchIndexListener returns early on
-- that event_type — but the pipeline's ledger path did not. Its stage source,
-- INDEX_EMBED_EVENT_SOURCE, selected on `is_deleted` alone, and `loadEventRows`
-- re-checked only that, so every planned block an autoplan run placed or moved
-- was embedded through the pipeline while the listener refused it. Two paths,
-- one guard.
--
-- The forward fix adds the exclusion to the stage predicate, to the row loader,
-- and to the backfill sweep's `backfillPredicate` for `event`, which had none —
-- so the sweep was also re-finding every planned block on every pass and
-- re-enqueueing it, and the listener was refusing it on arrival without a skip
-- marker. It repairs nothing already written, which is what this is for.
--
-- ## Why a migration, and why the orphan sweep will not do it
--
-- OrphanCleanupService decides "orphan" by whether the source row still exists
-- (plus a discriminator). These source rows do exist — they are live planned
-- blocks — so the sweep will never reap their index rows, and the new
-- `backfillPredicate` only stops NEW rows from being enqueued. The rows already
-- in ci_search.embeddings and ci_search.vectors stay until something removes
-- them, and until then a planned block is a search result and a recall
-- citation, which is exactly what the guardrail exists to prevent.
--
-- Both tables are keyed (entity_type, entity_id) with no FK to ci.events, so
-- the join is by uuid value. `ci.pipeline_state` is left alone: it is a ledger
-- of what ran, not an index, and the stage predicate now keeps these ids out
-- of its selection regardless of what the ledger records.

DELETE FROM ci_search.embeddings AS e
 USING ci.events AS ev
 WHERE e.entity_type = 'event'
   AND e.entity_id   = ev.event_id
   AND ev.event_type = 'planned_block';

DELETE FROM ci_search.vectors AS v
 USING ci.events AS ev
 WHERE v.entity_type = 'event'
   AND v.entity_id   = ev.event_id
   AND ev.event_type = 'planned_block';

-- migrate:down
-- No-op: irreversible data cleanup, same reasoning as the other repair
-- migrations here. The removed rows were index entries the guardrail says must
-- not exist; the forward code no longer produces them, and nothing records
-- which rows were present beforehand. Rolling the code back would regenerate
-- them through the same pipeline path on the next run.
