-- ============================================================================
-- RESET HYGIENE (search/embedding, #2/#3):
-- A data reset MUST also clear the search index (ci_search.embeddings /
-- ci_search.vectors). Those rows are keyed by (entity_type, entity_id) and have
-- NO FK/cascade to the ci.* source rows, so truncating ci.* WITHOUT ci_search
-- leaves the ENTIRE index pointing at deleted rows (i.e. 100% orphans). The loop
-- below already includes the 'ci_search' schema — keep it there. Any OTHER reset
-- path (importer wipe, manual ci.* + pgboss truncate, etc.) must likewise wipe
-- ci_search, e.g. via:  scripts/search-index-cleanup.ts truncate --confirm
-- ============================================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    -- 1. Clean up questions that are private to users
    -- We want to preserve questions where is_private_to IS NULL.
    -- So we delete the others.
    DELETE FROM ci.questions WHERE is_private_to IS NOT NULL;

    -- 2. Truncate all other tables except the ones we need to handle carefully
    -- We exclude:
    --   providers: to be preserved completely
    --   questions: partially preserved (handled above)
    --   users: referenced by questions (and others), needs careful deletion
    --   entities: referenced by users (and others), needs careful deletion
    FOR r IN (
        SELECT schemaname, tablename
        FROM pg_tables
        WHERE schemaname IN ('ci', 'ci_search', 'ci_etl')
          AND tablename NOT IN ('providers', 'questions', 'users', 'entities')
    ) LOOP
        EXECUTE 'TRUNCATE ' || quote_ident(r.schemaname) || '.' || quote_ident(r.tablename) || ' CASCADE;';
    END LOOP;

    -- 3. Handle circular dependency between users and entities
    -- users -> entities (entity_id, person_entity_id)
    -- entities -> users (owner_user_id)

    -- Break the link from users to entities
    UPDATE ci.users SET entity_id = NULL, person_entity_id = NULL;

    -- Now we can delete entities
    DELETE FROM ci.entities;

    -- 4. Now delete users
    DELETE FROM ci.users;
END $$;
