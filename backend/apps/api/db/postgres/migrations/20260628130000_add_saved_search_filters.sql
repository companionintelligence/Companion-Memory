-- migrate:up
-- A saved search previously persisted only query / entity types / tags, silently
-- dropping the rest of the explorer state (who / where / when / how / sort /
-- semantic). `filters` captures those secondary dimensions as a structured JSON
-- object so a saved search round-trips the full search the user built — and a
-- shared search runs with all of them.
ALTER TABLE ci.saved_searches
    ADD COLUMN filters JSONB;

-- migrate:down
ALTER TABLE ci.saved_searches
    DROP COLUMN IF EXISTS filters;
