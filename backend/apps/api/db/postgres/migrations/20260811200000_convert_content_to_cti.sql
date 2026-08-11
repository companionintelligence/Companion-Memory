-- migrate:up
-- =================================================================
-- CONTENT CTI - every ci.content row gains a ci.entities base row
-- =================================================================
-- Same class-table-inheritance shape as events (20260811061409) and
-- inventory (20260811061402): discriminator 'Content', shared uuid
-- (content.id = entities.entity_id), base row is the SOLE owner of title
-- (entities.name). Detail keeps text/url/mimetype/provenance/event_id.
--
-- Bulk rebuild is silent for graph_deltas (app writer / no triggers after
-- 20260811210000). See CI-Server#1941.

-- Rebuild only detail-table mirrors. Graph-ingest 'Content' rows with other
-- linked_table provenance keep their own ids/relationships.
DELETE FROM ci.entities
WHERE entity_type = 'Content'
  AND (linked_table = 'content'
       OR entity_id IN (SELECT id FROM ci.content));

INSERT INTO ci.entities
  (entity_id, entity_type, name, description, properties,
   owner_user_id, linked_table, linked_id, created_at, updated_at)
SELECT
  c.id,
  'Content',
  COALESCE(NULLIF(TRIM(c.title), ''), NULLIF(TRIM(c.url), ''), 'Untitled'),
  NULL,
  '{}'::jsonb,
  c.user_id,
  'content',
  c.id,
  c.created_at,
  c.updated_at
FROM ci.content c;

ALTER TABLE ci.content
  ADD COLUMN entity_type text NOT NULL DEFAULT 'Content'
    CONSTRAINT content_entity_type_check CHECK (entity_type = 'Content');

ALTER TABLE ci.content
  ADD CONSTRAINT content_id_entities_fk
  FOREIGN KEY (id, entity_type) REFERENCES ci.entities(entity_id, entity_type)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ci.content
  DROP COLUMN title;

-- migrate:down
-- One-way (normalization). Re-ingest or restore from backup.
