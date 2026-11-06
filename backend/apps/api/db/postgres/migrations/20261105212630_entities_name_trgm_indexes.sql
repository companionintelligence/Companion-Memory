-- migrate:up
-- The people and places lists filter by `name ILIKE '%q%'` (and people by the
-- structured first/last name in `properties`), and the search box's typeahead
-- runs that on every keystroke. `entities_name_idx` is a btree, which a
-- substring match cannot use, so every keystroke scanned every entity of the
-- user. Trigram GIN indexes serve ILIKE directly; pg_trgm is a trusted
-- extension, so the application role may create it, and the official postgres
-- image this appliance's database is built from ships it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS entities_name_trgm_idx
  ON ci.entities USING gin (name gin_trgm_ops)
  WHERE entity_type IN ('Person', 'Location') AND name IS NOT NULL;

CREATE INDEX IF NOT EXISTS entities_person_first_name_trgm_idx
  ON ci.entities USING gin ((properties->>'first_name') gin_trgm_ops)
  WHERE entity_type = 'Person';

CREATE INDEX IF NOT EXISTS entities_person_last_name_trgm_idx
  ON ci.entities USING gin ((properties->>'last_name') gin_trgm_ops)
  WHERE entity_type = 'Person';

-- migrate:down
DROP INDEX IF EXISTS ci.entities_person_last_name_trgm_idx;
DROP INDEX IF EXISTS ci.entities_person_first_name_trgm_idx;
DROP INDEX IF EXISTS ci.entities_name_trgm_idx;
-- pg_trgm stays: an extension is shared state, not this migration's to remove.
