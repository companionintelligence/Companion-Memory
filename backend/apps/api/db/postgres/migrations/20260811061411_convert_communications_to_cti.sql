-- migrate:up
-- =================================================================
-- COMMUNICATIONS CTI - every ci.communications row gains a base row
-- =================================================================
-- Third class-table-inheritance conversion, unblocked by the de-hypertabling
-- in 20260807072321 (id is the sole PK now, so a 1:1 FK to ci.entities is
-- finally enforceable). The base
-- row is discriminated 'Communication' and shares the SAME uuid as the
-- ci.communications detail row.
--
-- Unlike inventory/events, nothing is dropped here: subject/content/preview/
-- summary are domain data, not name duplicates. The base row's name is a
-- DERIVED display label — subject, else preview, else a one-line 140-char clip
-- of content (the same shape CommunicationEntity.previewFromContent produces)
-- — and description mirrors summary. CommunicationService re-derives both on
-- writes.
--
-- Scale: this is the largest table in the schema (typically ~0.5M rows, up to
-- a few million). The de-hypertable migration copied the whole table in one
-- statement at this size; the single INSERT ... SELECT below is the same
-- precedent. Base rows also flow through the ci.entities search_vector
-- trigger, so communications become findable in graph text search.

-- 1. Rebuild the 'Communication' slice of ci.entities from the detail table.
--
--    Delta triggers (20260809182943) OFF for the rebuild. This matters most
--    here: ci.communications is the largest table in the schema, so leaving
--    them on would write a ci.graph_deltas row per message, each carrying a
--    jsonb copy of name/description/properties, and
--    insight_aggregator.py would then narrate the migration to the user as
--    half a million newly created Communications. It would also materialize
--    the whole insert as a transition tuplestore before doing any of it.
--    entities_search_vector_trigger stays on, per the note above about
--    communications becoming findable in graph text search.
ALTER TABLE ci.entities DISABLE TRIGGER entities_graph_delta_delete;
ALTER TABLE ci.entities DISABLE TRIGGER entities_graph_delta_insert;

-- Scoped by provenance: only detail-table mirrors are rebuilt.
-- 'Communication'-typed rows created by graph ingest (linked_table
-- 'import:<source>') are real graph entities with their own ids and
-- relationships, not ci.communications mirrors, and must survive the rebuild.
-- The entity_id subselect additionally clears any row that would collide with
-- the re-insert below regardless of provenance.
DELETE FROM ci.entities
WHERE entity_type = 'Communication'
  AND (linked_table = 'communications'
       OR entity_id IN (SELECT id FROM ci.communications));

INSERT INTO ci.entities
  (entity_id, entity_type, name, description, properties,
   owner_user_id, linked_table, linked_id, created_at, updated_at)
SELECT
  c.id, 'Communication',
  -- NULLIF(trim(...)) on every branch: importers commonly store no-subject
  -- messages as subject = '' (not NULL), which must fall through to the next
  -- branch instead of producing a blank label.
  COALESCE(
    NULLIF(trim(c.subject), ''),
    NULLIF(trim(c.preview), ''),
    NULLIF(
      CASE
        WHEN length(regexp_replace(c.content, '\s+', ' ', 'g')) > 140
          THEN left(trim(regexp_replace(c.content, '\s+', ' ', 'g')), 139) || '…'
        ELSE trim(regexp_replace(c.content, '\s+', ' ', 'g'))
      END,
      ''
    )
  ),
  c.summary, '{}'::jsonb,
  c.user_id, 'communications', c.id,
  c.time, c.time
FROM ci.communications c;

ALTER TABLE ci.entities ENABLE TRIGGER entities_graph_delta_insert;
ALTER TABLE ci.entities ENABLE TRIGGER entities_graph_delta_delete;

-- 2. The CTI invariant: no detail row without its base row, AND the base row
--    must carry the matching discriminator: the FK target is the composite
--    (entity_id, entity_type), backed by entities_entity_id_entity_type_key
--    from the inventory conversion (20260811061402), with the detail half
--    pinned by a constant CHECKed column no writer names.
--
--    DEFERRABLE INITIALLY DEFERRED so bulk ingest may insert detail-then-base
--    inside one transaction; ON DELETE CASCADE so deleting the base row deletes
--    the aggregate as one unit.
ALTER TABLE ci.communications
  ADD COLUMN entity_type text NOT NULL DEFAULT 'Communication'
    CONSTRAINT communications_entity_type_check CHECK (entity_type = 'Communication');

ALTER TABLE ci.communications
  ADD CONSTRAINT communications_id_entities_fk
  FOREIGN KEY (id, entity_type) REFERENCES ci.entities(entity_id, entity_type)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- migrate:down
-- One-way (the FK and base rows are the new source of graph identity);
-- re-ingest instead of restoring.
