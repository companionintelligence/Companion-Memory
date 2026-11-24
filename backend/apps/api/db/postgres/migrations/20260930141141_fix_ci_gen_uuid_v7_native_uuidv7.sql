-- migrate:up
-- Make ci.gen_uuid_v7() mint real UUIDv7 again.
--
-- ci.gen_uuid_v7() is the primary-key default for 50 tables across ci,
-- ci_import, ci_etl and ci_derived (ci.entities, ci.events, ci.files,
-- ci.identifier_claims, ci_import.staged_items, ...). Its body still called the
-- pg_uuidv7 extension's uuid_generate_v7() and trapped undefined_function to
-- fall back to gen_random_uuid(). The PG18 upgrade (2026-06-11) stopped building
-- pg_uuidv7 into ci/database and stopped setup-database creating it, so since
-- then every call has taken the fallback and minted a random UUIDv4. Nothing
-- noticed, because the fallback logs nothing.
--
-- ## Why 20260611030000_use_native_uuidv7 did not fix it
--
-- It was written for exactly this, but it replaced an UNQUALIFIED
-- gen_uuid_v7(). An unqualified CREATE lands in the first schema on the
-- search_path ("$user", public -- so public), not wherever a function of that
-- name already lives, and 20251214211043 had moved the original into ci. So it
-- created a second function, public.gen_uuid_v7(), which does call uuidv7(),
-- and left ci.gen_uuid_v7() as it was. The 12 primary keys whose migrations
-- have since written an unqualified DEFAULT gen_uuid_v7() (ci.asks, ci.tasks,
-- ci.reminders, ...) bind to the public one, which is why only some tables got
-- random ids.
--
-- ## What this does
--
-- Replaces ci.gen_uuid_v7() -- by its qualified name -- with a call to PG18's
-- pg_catalog.uuidv7(). There is deliberately no fallback: if uuidv7() is ever
-- missing, inserts must fail loudly rather than quietly mint v4 again. It is
-- LANGUAGE sql rather than plpgsql, so that
--   * the body is resolved at CREATE time: on a server without uuidv7() this
--     migration fails, instead of every INSERT after it;
--   * the planner inlines it into the column defaults that call it; and
--   * there is no EXCEPTION block, which cost a subtransaction and a caught
--     error on every id minted.
--
-- Existing ids are NOT rewritten; only new ones change. Every id minted without
-- the extension stays v4: rows the app wrote on the PG18 image, and rows that
-- earlier migrations insert themselves. The latter recur on every FRESH install,
-- because every older migration runs before this one -- today that is 2,093 of
-- the 2,106 seeded ci.questions. Almost all v4 ids sort above every v7 id (a v7
-- id minted in 2025-26 begins 019 or 01a; a v4 id can begin with anything), in
-- random order among themselves. So ORDER BY <id> is not chronological across
-- them and never will be -- order by a timestamp column.
--
-- ## Why public.gen_uuid_v7() stays
--
-- 12 primary-key defaults bind to it by OID, it already returns uuidv7(), and
-- nothing else calls it -- no function body, view, application query, or other
-- repo. Dropping it would mean re-pointing those defaults under ACCESS
-- EXCLUSIVE locks, and would turn any branch still writing an unqualified
-- DEFAULT gen_uuid_v7() into a failed migrate, for no change in behaviour. It
-- is left as it is. Both twins get a COMMENT naming the other, so the next
-- change does not land in only one of them again.

CREATE OR REPLACE FUNCTION ci.gen_uuid_v7()
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $$
  SELECT pg_catalog.uuidv7()
$$;

COMMENT ON FUNCTION ci.gen_uuid_v7() IS
  'UUIDv7 primary-key default: calls the PG18 builtin uuidv7(), no fallback. '
  'Has a twin, public.gen_uuid_v7(), which 12 tables default to because their '
  'migrations wrote it unqualified -- change both, by qualified name. New tables '
  'should default to ci.gen_uuid_v7().';

COMMENT ON FUNCTION public.gen_uuid_v7() IS
  'Twin of ci.gen_uuid_v7(), created when 20260611030000_use_native_uuidv7 '
  'replaced gen_uuid_v7() unqualified. Kept because 12 primary keys default to it. '
  'Change both, by qualified name.';

-- Prove it on this database rather than in this file: evaluate every column
-- default that calls either twin and require a version-7 UUID back.
-- 20260611030000 would have failed this the day it shipped.
DO $$
DECLARE
  col record;
  version int;
  checked int := 0;
BEGIN
  FOR col IN
    SELECT ad.adrelid::regclass AS tbl, a.attname AS col,
           pg_get_expr(ad.adbin, ad.adrelid) AS expr
      FROM pg_depend d
      JOIN pg_attrdef ad ON ad.oid = d.objid
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE d.classid = 'pg_attrdef'::regclass
       AND d.refclassid = 'pg_proc'::regclass
       AND d.refobjid IN (SELECT oid FROM pg_proc WHERE proname = 'gen_uuid_v7')
  LOOP
    EXECUTE format('SELECT pg_catalog.uuid_extract_version(%s)', col.expr) INTO version;

    IF version IS DISTINCT FROM 7 THEN
      RAISE EXCEPTION '%.% defaults to %, which mints version % UUIDs, not 7',
        col.tbl, col.col, col.expr, version;
    END IF;

    checked := checked + 1;
  END LOOP;

  IF checked = 0 THEN
    RAISE EXCEPTION 'No column default calls gen_uuid_v7(), so nothing was verified';
  END IF;
END $$;


-- migrate:down
-- Restores the definition this migration found, v4 fallback included, so that
-- up/down/up round-trips exactly. That is the broken state: on the current
-- image it mints UUIDv4 again.
COMMENT ON FUNCTION public.gen_uuid_v7() IS NULL;
COMMENT ON FUNCTION ci.gen_uuid_v7() IS NULL;

CREATE OR REPLACE FUNCTION ci.gen_uuid_v7()
RETURNS UUID AS $$
BEGIN
    RETURN uuid_generate_v7();
EXCEPTION
    WHEN undefined_function THEN
        RETURN gen_random_uuid();
END;
$$ LANGUAGE plpgsql;
