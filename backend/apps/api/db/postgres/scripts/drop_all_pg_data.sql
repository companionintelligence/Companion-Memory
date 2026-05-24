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
