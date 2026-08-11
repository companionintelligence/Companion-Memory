-- migrate:up
-- =================================================================
-- EVENTS CTI - every ci.events row gains a ci.entities base row
-- =================================================================
-- Second class-table-inheritance conversion, fully normalized like inventory's
-- (20260811061402): the base row is discriminated 'Event', shares the SAME
-- uuid as the ci.events detail row
-- (events.event_id = entities.entity_id), and is the SOLE owner of the event's
-- title (stored as entities.name) and description. The events copies are
-- moved into it and dropped. Base rows carrying real text also means events
-- land in the ci.entities search_vector (graph text search).
--
-- ci.events.event_entity_id was a dead graph-mirror precursor (its only writer
-- sits behind a resolver that never forwards the field); dropped below.
--
-- Python readers were updated in the same change (summary insight/action
-- aggregators, hbpe unlabeled-events queries) to join ci.entities for the
-- title. summary's data_aggregator introspects information_schema per run but
-- caches it per-process; restart the summary worker at deploy.

-- 1. Rebuild the 'Event' slice of ci.entities from the detail table, moving
--    title/description into the base row (title is NOT NULL, so every base row
--    gets a name). linked_table/linked_id carry the self-describing provenance
--    pair ('events', event_id).
--
--    Delta triggers (20260809182943) OFF for the rebuild, same reasoning as
--    inventory's: a schema migration is not a graph change, and every row here
--    would otherwise reach the user through insight_aggregator.py as a created
--    event. entities_search_vector_trigger stays on, because events landing in
--    the graph search vector is one of the things this migration is FOR.
ALTER TABLE ci.entities DISABLE TRIGGER entities_graph_delta_delete;
ALTER TABLE ci.entities DISABLE TRIGGER entities_graph_delta_insert;

-- Scoped by provenance: only detail-table mirrors are rebuilt. 'Event'-typed
-- rows created by graph ingest (linked_table 'import:<source>') are real graph
-- entities with their own ids and relationships, not ci.events mirrors, and
-- must survive the rebuild. The entity_id subselect additionally clears any
-- row that would collide with the re-insert below regardless of provenance.
DELETE FROM ci.entities
WHERE entity_type = 'Event'
  AND (linked_table = 'events'
       OR entity_id IN (SELECT event_id FROM ci.events));

INSERT INTO ci.entities
  (entity_id, entity_type, name, description, properties,
   owner_user_id, linked_table, linked_id, created_at, updated_at)
SELECT
  e.event_id, 'Event', e.title, e.description, '{}'::jsonb,
  e.user_id, 'events', e.event_id,
  e.created_at, e.updated_at
FROM ci.events e;

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
--    the aggregate as one unit. Downstream FK behavior is unchanged: deleting
--    an event still SET NULLs capture_events/object_observations/receipts and
--    still RESTRICTs on hbpe.l1_event_cluster when the event is clustered.
ALTER TABLE ci.events
  ADD COLUMN entity_type text NOT NULL DEFAULT 'Event'
    CONSTRAINT events_entity_type_check CHECK (entity_type = 'Event');

ALTER TABLE ci.events
  ADD CONSTRAINT events_event_id_entities_fk
  FOREIGN KEY (event_id, entity_type) REFERENCES ci.entities(entity_id, entity_type)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- 3. Normalize: the base row owns title/description now; the dead mirror
--    column goes with them.
ALTER TABLE ci.events
  DROP COLUMN title,
  DROP COLUMN description,
  DROP COLUMN event_entity_id;

-- migrate:down
-- One-way (normalization). Restoring the detail-side columns would require
-- copying values back out of ci.entities; re-ingest instead.
