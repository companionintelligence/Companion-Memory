-- migrate:up
-- `ensureDefaults` bulk-inserts the ~148-row starter library into every fresh
-- user's saved searches, indistinguishable from a search they created
-- themselves once written. This column lets the frontend split them into a
-- clearly-labelled, collapsed "Starter searches" section instead of drowning
-- a user's own two rows in someone else's demo data.
ALTER TABLE ci.saved_searches
    ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT false;

-- migrate:down
ALTER TABLE ci.saved_searches
    DROP COLUMN IF EXISTS is_seed;
