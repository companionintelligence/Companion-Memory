-- migrate:up

-- Drop tables requested for removal.
-- CASCADE ensures dependent indexes, constraints, and table-bound triggers are removed as well.
DROP TABLE IF EXISTS ci.habit_completions CASCADE;
DROP TABLE IF EXISTS ci.habits CASCADE;
DROP TABLE IF EXISTS ci.goals CASCADE;
DROP TABLE IF EXISTS ci.document_chunks CASCADE;
DROP TABLE IF EXISTS ci.documents CASCADE;
DROP TABLE IF EXISTS ci.facts CASCADE;
DROP TABLE IF EXISTS ci.measurements CASCADE;
DROP TABLE IF EXISTS ci.activities CASCADE;
DROP TABLE IF EXISTS ci.voice_recordings CASCADE;
DROP TABLE IF EXISTS ci.tags CASCADE;

-- Remove function tied to the removed document_chunks full-text trigger.
DROP FUNCTION IF EXISTS ci.document_chunks_search_vector_update();
DROP FUNCTION IF EXISTS ci.facts_search_vector_update();

-- migrate:down
-- Irreversible migration by design.
