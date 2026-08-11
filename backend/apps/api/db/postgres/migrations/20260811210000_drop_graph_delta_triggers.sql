-- migrate:up
-- =================================================================
-- Drop graph_deltas DB triggers — app writes via GraphDeltaWriter
-- =================================================================
-- Statement-level triggers on ci.entities / ci.relationships are replaced by
-- explicit inserts from GraphDeltaWriter (MemoryModule) and fold SQL helpers.
-- change_source becomes a service name (e.g. ContentService.create) instead of
-- 'db_trigger'. See CI-Server#1941 / PR #1942.
--
-- FKs from graph_deltas to entities/relationships stay dropped (history outlives
-- subjects) — do not re-add them here.

DROP TRIGGER IF EXISTS relationships_graph_delta_delete ON ci.relationships;
DROP TRIGGER IF EXISTS relationships_graph_delta_update ON ci.relationships;
DROP TRIGGER IF EXISTS relationships_graph_delta_insert ON ci.relationships;
DROP TRIGGER IF EXISTS entities_graph_delta_delete ON ci.entities;
DROP TRIGGER IF EXISTS entities_graph_delta_update ON ci.entities;
DROP TRIGGER IF EXISTS entities_graph_delta_insert ON ci.entities;

DROP FUNCTION IF EXISTS ci.record_relationship_graph_delta();
DROP FUNCTION IF EXISTS ci.record_entity_graph_delta();

-- migrate:down
-- Recreate is not inlined: restore from 20260809182943_graph_delta_triggers.sql
-- if a rollback is required. Empty down keeps dbmate happy for forward-only
-- appliance deploys.
SELECT 1;
