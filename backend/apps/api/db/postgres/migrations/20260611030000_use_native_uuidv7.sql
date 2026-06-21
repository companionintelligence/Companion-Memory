-- migrate:up

-- PG18 ships a native uuidv7() builtin; rewrite gen_uuid_v7() to call
-- it directly so we no longer depend on the pg_uuidv7 extension.
CREATE OR REPLACE FUNCTION gen_uuid_v7()
RETURNS UUID AS $$
BEGIN
    RETURN uuidv7();
END;
$$ LANGUAGE plpgsql;


-- migrate:down

-- Restore the extension-backed implementation with a v4 fallback.
CREATE OR REPLACE FUNCTION gen_uuid_v7()
RETURNS UUID AS $$
BEGIN
    RETURN uuid_generate_v7();
EXCEPTION
    WHEN undefined_function THEN
        RETURN gen_random_uuid();
END;
$$ LANGUAGE plpgsql;
