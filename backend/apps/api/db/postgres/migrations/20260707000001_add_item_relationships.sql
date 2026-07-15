-- migrate:up
-- Item↔item graph edges from the importer (email→attachment, photo→album).
--
-- The importer's timeline records item↔item edges (relationships.related_item_id
-- in its SQLite), but the event/graph push only ever collapsed edges into
-- user↔entity (self→entity) — so these edges were dropped platform-wide. This
-- table is their landing zone.
--
-- Items are referenced by their PROVENANCE TRIPLE (source_type, source_system,
-- source_id) rather than a CI-Server row id, because a single importer item may
-- land in ci.events, ci.communications, ci.content, or ci.inventory depending on
-- its kind — the triple is the one stable, table-agnostic handle both sides
-- already share (see CI-Import-Tools mapping.ts sourceTriple: source_type is the
-- constant 'ci-import-tools', source_system is items.data_source, source_id is
-- items.id).
--
-- Idempotency: the UNIQUE(user_id, from-triple, to-triple, relation) index makes
-- a re-send an ON CONFLICT DO NOTHING no-op, matching the source-triple dedup the
-- rest of ingest uses. The importer sends these set-based via
-- bulkIngestItemRelationships.
CREATE TABLE IF NOT EXISTS ci.item_relationships (
    id                 UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id            UUID        NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    from_source_type   TEXT        NOT NULL,
    from_source_system TEXT        NOT NULL,
    from_source_id     TEXT        NOT NULL,
    to_source_type     TEXT        NOT NULL,
    to_source_system   TEXT        NOT NULL,
    to_source_id       TEXT        NOT NULL,
    relation           TEXT        NOT NULL,
    metadata           JSONB       NOT NULL DEFAULT '{}',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The idempotency arbiter: one edge per (owner, from-triple, to-triple,
-- relation). bulkIngestItemRelationships targets this index verbatim in its
-- INSERT ... ON CONFLICT DO NOTHING so re-sends dedup instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS item_relationships_edge_uniq
    ON ci.item_relationships (
        user_id,
        from_source_type, from_source_system, from_source_id,
        to_source_type, to_source_system, to_source_id,
        relation
    );

-- Reverse-lookup helpers: resolve every edge pointing FROM or TO a given item
-- triple (e.g. "what are this email's attachments", "which album holds this
-- photo") without scanning the whole table.
CREATE INDEX IF NOT EXISTS item_relationships_from_idx
    ON ci.item_relationships (user_id, from_source_type, from_source_system, from_source_id);
CREATE INDEX IF NOT EXISTS item_relationships_to_idx
    ON ci.item_relationships (user_id, to_source_type, to_source_system, to_source_id);

-- migrate:down
DROP INDEX IF EXISTS ci.item_relationships_to_idx;
DROP INDEX IF EXISTS ci.item_relationships_from_idx;
DROP INDEX IF EXISTS ci.item_relationships_edge_uniq;
DROP TABLE IF EXISTS ci.item_relationships;
