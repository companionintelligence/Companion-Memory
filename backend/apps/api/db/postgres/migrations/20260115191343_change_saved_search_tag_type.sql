-- migrate:up
ALTER TABLE ci.saved_searches ALTER column tags TYPE TEXT[] using tags::TEXT[];


-- migrate:down
ALTER TABLE ci.saved_seaches ALTER COLUMN tags UUID[];
