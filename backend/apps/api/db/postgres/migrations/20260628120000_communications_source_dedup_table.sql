-- migrate:up
-- communications_source_triple_uniq HAD to include `time` because
-- ci.communications is a TimescaleDB hypertable partitioned on (time, user_id),
-- and TimescaleDB hard-rejects UNIQUE indexes that don't cover every partition
-- column (`cannot create a unique index without the column "time" (used in
-- partitioning)`). But the importer-derived `time` is NOT stable across
-- re-syncs for sources whose row body lacks a usable timestamp — iMessage
-- attachment-only entries and some Google Voice rows fall back to import
-- wall-clock — so two import sweeps days apart minted two communications rows
-- for the same provenance triple (27,700 dup imessage rows, 7,318 dup
-- google_voice rows on a real local DB). Every future re-import would mint
-- another generation of duplicates.
--
-- Move the idempotency invariant off the hypertable and onto a companion
-- lookup table that owns the (user_id, source_type, source_system, source_id)
-- tuple. The lookup table is NOT a hypertable, so its PRIMARY KEY can be the
-- pure provenance triple — no `time` smuggled in. ci.communications retains the
-- triple columns and the hypertable PK, but uniqueness is enforced upstream:
-- CommunicationService.createMany now consults this table before inserting.
CREATE TABLE IF NOT EXISTS ci.communications_source_dedup (
    user_id            UUID        NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    source_type        TEXT        NOT NULL,
    source_system      TEXT        NOT NULL,
    source_id          TEXT        NOT NULL,
    -- Pointer back to the canonical communication. Hypertable FKs are awkward
    -- (the PK is composite (time, user_id, id) and chunk drops would cascade
    -- here), so the link is soft — application code keeps it consistent and a
    -- stale pointer is harmless (the next ingest re-resolves the triple).
    communication_id   UUID        NOT NULL,
    communication_time TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, source_type, source_system, source_id)
);

-- Reverse-lookup for delete-cascade-style cleanup: when a communication row is
-- removed, the writer also drops its dedup pointer so the next re-ingest
-- treats it as new.
CREATE INDEX IF NOT EXISTS communications_source_dedup_comm_id_idx
    ON ci.communications_source_dedup (communication_id);

-- Backfill: one dedup row per distinct provenance triple, pointing at the
-- OLDEST communication row for that triple. The oldest is the canonical one —
-- it was ingested first, downstream relationships and search-index rows
-- already reference it, and its `time` is the closest to the source-of-record
-- value (the placeholder wall-clock falls back happen on later re-imports).
INSERT INTO ci.communications_source_dedup
    (user_id, source_type, source_system, source_id, communication_id, communication_time)
SELECT DISTINCT ON (user_id, source_type, source_system, source_id)
       user_id, source_type, source_system, source_id, id, time
  FROM ci.communications
 WHERE source_id IS NOT NULL
   AND source_type IS NOT NULL
   AND source_system IS NOT NULL
 ORDER BY user_id, source_type, source_system, source_id, time ASC, id ASC
ON CONFLICT (user_id, source_type, source_system, source_id) DO NOTHING;

-- Delete the non-canonical duplicates. Anything in ci.communications with a
-- provenance triple whose (id, time) doesn't match the dedup pointer is a
-- replay artefact and goes. Bounded on (user_id, source_*) so the planner can
-- still prune chunks via the partial index predicate.
DELETE FROM ci.communications c
 USING ci.communications_source_dedup d
 WHERE c.user_id       = d.user_id
   AND c.source_type   = d.source_type
   AND c.source_system = d.source_system
   AND c.source_id     = d.source_id
   AND (c.id <> d.communication_id OR c.time <> d.communication_time);

-- Drop the time-bearing partial unique. It's no longer the source of truth for
-- idempotency (the dedup table is), and leaving it in place is actively
-- misleading: it would still permit time-drifted duplicates (the exact bug we
-- just fixed) while implying the schema enforces the invariant. The writer no
-- longer issues an ON CONFLICT targeting this index either.
DROP INDEX IF EXISTS ci.communications_source_triple_uniq;

-- Soft delete-cascade: when a communication row is removed (via the service's
-- remove() path OR a hypertable chunk drop OR a manual DELETE), clear the
-- dedup pointer too so the next re-ingest treats the triple as new. The link
-- is soft on purpose (see the table comment above), so this trigger replaces
-- what a FK ON DELETE CASCADE would have given us if hypertable FKs were
-- ergonomic. The trigger is per-row and predicated on source_id IS NOT NULL so
-- non-dedupable rows skip the dedup lookup entirely.
CREATE OR REPLACE FUNCTION ci.communications_source_dedup_after_delete_fn()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM ci.communications_source_dedup d
     WHERE d.user_id = OLD.user_id
       AND d.source_type = OLD.source_type
       AND d.source_system = OLD.source_system
       AND d.source_id = OLD.source_id
       AND d.communication_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS communications_source_dedup_after_delete ON ci.communications;
CREATE TRIGGER communications_source_dedup_after_delete
    AFTER DELETE ON ci.communications
    FOR EACH ROW
    WHEN (OLD.source_id IS NOT NULL)
    EXECUTE FUNCTION ci.communications_source_dedup_after_delete_fn();

-- migrate:down
-- Recreate the original (broken) partial unique first — only possible if the
-- caller has already dedupe-truncated by a different route, otherwise the
-- index build will fail on the same duplicates we just removed.
CREATE UNIQUE INDEX IF NOT EXISTS communications_source_triple_uniq
    ON ci.communications (user_id, time, source_type, source_system, source_id)
    WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.communications_source_dedup_comm_id_idx;
DROP TABLE IF EXISTS ci.communications_source_dedup;
