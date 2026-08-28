-- migrate:up

-- Take the FABRICATED PHONE NUMBERS off the Twitter DM partners the archive
-- could not name, and bring those rows into line with what the fixed parser
-- now writes.
--
-- ## The bug this cleans up after
--
-- `datasources/twitter.ts` resolves a DM partner's numeric account id against
-- the id -> `@handle` pairs `tweets.js` carries, and for everyone it cannot
-- name it used to emit the BARE ID as the participant. A bare id is not inert.
-- `classifyParticipant` (`domains/graph/utils/normalizeIdentifier.ts`) types an
-- all-digit string as `kind='phone'` once it holds `PHONE_MIN_DIGITS` = 7 of
-- them, and there is NO upper bound -- E.164 stops at 15 digits, a Twitter
-- snowflake is 18-19 -- so every unresolved partner cleared the phone test.
-- `normalizePhone` then kept its LAST TEN DIGITS, `PersonStubBackfillService`
-- minted a `Person` named after the id, and `GraphIngestService` indexed those
-- ten digits into `ci.entity_identifiers` as a phone number belonging to
-- nobody.
--
-- Measured on a fresh full-corpus import (main @ 384fa8b6a):
--
--   223 `Person` rows are named entirely of digits. 214 of them are these
--   Twitter stubs, carrying 213 fabricated `phone` identifiers (the 214th is a
--   4-digit id, too short for the phone branch, which landed as a `name`).
--   119 are 7-15 digits and so indistinguishable from a real number; of the 103
--   snowflakes, 87 reduce to a last-ten that even starts with a valid NANP
--   area-code digit.
--
-- The cost is not clutter. `PersonLinkStage` matches `phone_last10` at 0.85
-- confidence, so a fabricated number equal to a real contact's merges a
-- stranger's DMs into a real person. All 213 values were checked against every
-- other phone identifier on this corpus and none collides -- the exposure is
-- latent, not realised, which is the argument for closing it before a corpus
-- arrives where it does.
--
-- ## Why the data has to be repaired and not just the parser
--
-- Fixing `twitter.ts` alone stops the next IMPORT from minting these. It does
-- not stop `extract_people`, which `SmartRotationListener` runs on a schedule
-- and which reads `ci.communications.participants_metadata` -- where the bare
-- ids still sit. Delete the entities and leave the strings and the very next
-- sweep mints them again with the same fabricated phones; that is what
-- 20260818220731 did, and 20260819001555 is the migration that had to undo it.
-- Deleting the output of a generator that is still running is theatre, so this
-- file repairs the STRING first and the entities it already minted second.
--
-- ## Re-key, not delete
--
-- `GraphIngestService` derives `linked_id = uuidv5(key, IMPORT_NAMESPACE)`, and
-- `PersonStubBackfillService` builds that key as
-- `communications:participant:<kind>:<value_normalized>`. The participant's
-- identity is therefore IN the coordinate: renaming a row without moving its
-- key leaves the next `extract_people` sweep resolving
-- `communications:participant:name:twitter:id:<id>` to nothing and minting a
-- SECOND row beside the repaired one. So the key moves with the name.
--
-- Moving it (rather than dropping the row and letting it be re-minted) is also
-- what keeps the conversations attached: on this corpus these 214 entities are
-- referenced by 735 `communications.from_entity_id`, 68,605 `to_entity_ids`
-- elements and 69,340 `ci.relationships` rows. `entity_id` never changes here,
-- so every one of those survives untouched.
--
-- ## Scope, and why the Twitter provenance is load-bearing
--
-- The stub key records the KIND of identifier, never the source system, so
-- `linked_table` alone cannot separate a Twitter account id from a real number
-- some other export happened to write as bare digits -- and renaming a genuine
-- correspondent to `twitter:id:<their number>` would be a worse bug than the
-- one being fixed. That population is not hypothetical: this corpus holds 366
-- bare-digit participant strings, and they split exactly two ways --
--
--   on twitter only   214 strings, all 214 with a participant stub  <- repaired
--   on other sources  152 strings, none with a participant stub     <- untouched
--
-- with ZERO appearing on both. The 152 are Google Voice numeric participants
-- that already resolve to `import:google_voice` entities (32665106, 20000102,
-- ...), a population owned by that parser and addressed by #2150 / #2173.
--
-- Membership therefore requires the name to appear as a participant on a
-- `source_system = 'twitter'` communication AND on no other source's. A string
-- that appeared on both would be genuinely ambiguous and is left alone rather
-- than guessed at.
--
-- The `linked_id` equality is the other half: it is true only of a row whose
-- key WAS the pre-fix one, i.e. minted by `PersonStubBackfillService` from a
-- bare id. It matched 213 rows through the phone branch and 1 through the name
-- branch -- 214 of 214 candidates -- which is what makes this scope provable
-- rather than asserted.
--
-- Rows already tombstoned by a merge are included on purpose, for the reason
-- 20260819145023 gives: `upsertEntities` resolves a coordinate THROUGH
-- `merged_into_entity_id`, so re-keying a tombstone preserves a human's merge
-- decision against future imports instead of letting the account come back.
--
-- ## Deliberately NOT done
--
-- No row is retyped and none is deleted. These people are real correspondents
-- with real conversations; only the NAME the archive left them with was wrong.
-- `Concept` would be the wrong answer here for the reason 20260819145023 gives
-- for the opposite case: a short code is a service, while a DM partner is a
-- human the account exchanged messages with, and the only thing the archive
-- failed to supply is their handle.
--
-- The namespace literal below is `IMPORT_NAMESPACE` from
-- `GraphIngestService.ts` ("Do not change -- it is the idempotency anchor"),
-- the key shape is `PersonStubBackfillService`'s `STUB_SOURCE_SYSTEM` +
-- `<kind>:<value>`, and `twitter:id:` is `ACCOUNT_ID_NAMESPACE` in
-- `datasources/twitter.ts`. All four have to stay in step.

-- `uuid-ossp` supplies the only RFC-4122 v5 (SHA-1) generator available to SQL:
-- PostgreSQL 18 ships `uuidv4`/`uuidv7` builtins and no v5, and `sha1` itself
-- lives in an extension too. It is provisioned per-appliance rather than by a
-- migration (`infrastructure/setup-database/entrypoint.sh`), so it may be
-- absent, and where it is present it may be installed into `ci` rather than
-- `public` -- hence resolving its schema instead of assuming one. It is a
-- TRUSTED extension, so the database owner may create it without superuser.
DO $$
DECLARE
  v5_schema text;
BEGIN
  SELECT n.nspname INTO v5_schema
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'uuid_generate_v5'
   ORDER BY (n.nspname = 'ci') DESC, n.nspname
   LIMIT 1;

  IF v5_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"';

    SELECT n.nspname INTO v5_schema
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'uuid_generate_v5'
     ORDER BY (n.nspname = 'ci') DESC, n.nspname
     LIMIT 1;
  END IF;

  IF v5_schema IS NULL THEN
    RAISE EXCEPTION 'uuid_generate_v5 is unavailable: install the uuid-ossp extension and re-run';
  END IF;

  -- SET LOCAL from a DO block lasts to the end of the migration's transaction
  -- (a DO block has no per-function SET clause to revert it), so the statements
  -- below can call `uuid_generate_v5` unqualified. It MUST be RESET before this
  -- file ends -- see the RESET at the bottom of the up migration.
  EXECUTE format('SET LOCAL search_path = %I, ci, public', v5_schema);
END
$$;

-- Every bare-digit participant string on a Twitter communication, and whether
-- any NON-Twitter communication uses the same string. Computed BEFORE the
-- rewrite below, because the rewrite is what destroys the provenance evidence.
--
-- A bare-digit participant on a Twitter row is always an account id and never a
-- handle: `handlesById` stores a resolved handle as `@screen_name`, with the
-- `@` always present, so a numeric screen name cannot reach here bare.
CREATE TEMP TABLE _tw_participant_strings ON COMMIT DROP AS
SELECT v AS name,
       bool_or(c.source_system = 'twitter') AS on_twitter,
       bool_or(c.source_system IS DISTINCT FROM 'twitter') AS on_other_source
  FROM ci.communications c
  CROSS JOIN LATERAL (
    SELECT c.participants_metadata ->> 'from' AS v
    UNION ALL
    SELECT e.value
      FROM (VALUES ('to'), ('cc'), ('bcc')) AS f(field)
      CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(c.participants_metadata -> f.field) = 'array'
                  THEN c.participants_metadata -> f.field
                  ELSE '[]'::jsonb
             END) AS e(value)
  ) AS s(v)
 WHERE s.v ~ '^[0-9]+$'
 GROUP BY s.v;

CREATE INDEX ON _tw_participant_strings (name);

-- The entity working set, computed ONCE.
--
-- `new_name` is `accountRef()` from the fixed parser. `new_linked_id` is the
-- coordinate `PersonStubBackfillService` will derive for it: the participant
-- classifies as `kind='name'` now (letters and colons fail the phone SHAPE test
-- in both `classifyParticipant` and `PersonLinkStage.classifyIdentifier`), and
-- `normalizeName` leaves an already-lower-case, space-free string alone, so
-- `value_normalized` and the display name are the same string.
CREATE TEMP TABLE _tw_account_id_people ON COMMIT DROP AS
SELECT e.entity_id,
       e.owner_user_id,
       e.linked_table,
       e.name AS old_name,
       -- The pre-fix identifier `classifyParticipant` derived from the bare id:
       -- phone (last ten digits) from seven digits up, name below that.
       CASE WHEN length(e.name) >= 7
            THEN 'phone:' || CASE WHEN length(e.name) > 10 THEN right(e.name, 10) ELSE e.name END
            ELSE 'name:' || e.name
       END AS old_key_tail,
       'twitter:id:' || e.name AS new_name,
       uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                        'communications:participant:name:twitter:id:' || e.name) AS new_linked_id
  FROM ci.entities e
  JOIN _tw_participant_strings s ON s.name = e.name
 WHERE e.entity_type = 'Person'
   AND e.linked_table = 'import:communications:participant'
   AND e.name ~ '^[0-9]+$'
   AND s.on_twitter
   AND NOT s.on_other_source
   AND e.linked_id = uuid_generate_v5(
         '6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
         'communications:participant:' ||
           CASE WHEN length(e.name) >= 7
                THEN 'phone:' || CASE WHEN length(e.name) > 10 THEN right(e.name, 10) ELSE e.name END
                ELSE 'name:' || e.name
           END);

CREATE INDEX ON _tw_account_id_people (entity_id);
CREATE INDEX ON _tw_account_id_people (old_name);

-- (1) The string that mints them. Rewritten for EVERY bare-digit participant on
-- a Twitter communication, which is a wider set than the entities above: a
-- string that also appears on another source is left out of the entity repair
-- (it is ambiguous -- see Scope) but its Twitter rows are still corrected, so
-- the two sources stop sharing one identity. Zero such strings exist on this
-- corpus; the statement is written for the general case regardless.
UPDATE ci.communications c
   SET participants_metadata =
         jsonb_set(c.participants_metadata, '{from}',
                   to_jsonb('twitter:id:' || (c.participants_metadata ->> 'from')))
 WHERE c.source_system = 'twitter'
   AND c.participants_metadata ->> 'from' ~ '^[0-9]+$';

-- `to`/`cc`/`bcc`: map the bare-digit elements and keep every other element,
-- IN ORDER -- `RecipientIds` is a positional sibling of this array, so a
-- reordering here would silently de-align the two. Twitter writes only `to`
-- today; `cc`/`bcc` ride along because "the shape that was corrupted once" is a
-- poor scope for a repair.
UPDATE ci.communications c
   SET participants_metadata = jsonb_set(c.participants_metadata, ARRAY[fixed.field], fixed.mapped)
  FROM (
    SELECT s.id,
           s.field,
           (SELECT jsonb_agg(CASE WHEN e.value ~ '^[0-9]+$' THEN 'twitter:id:' || e.value ELSE e.value END
                             ORDER BY e.ord)
              FROM jsonb_array_elements_text(s.arr) WITH ORDINALITY AS e(value, ord)) AS mapped
      FROM (
        SELECT c2.id, f.field, c2.participants_metadata -> f.field AS arr
          FROM ci.communications c2
          CROSS JOIN (VALUES ('to'), ('cc'), ('bcc')) AS f(field)
         WHERE c2.source_system = 'twitter'
           AND jsonb_typeof(c2.participants_metadata -> f.field) = 'array'
           AND EXISTS (SELECT 1
                         FROM jsonb_array_elements_text(c2.participants_metadata -> f.field) AS e(value)
                        WHERE e.value ~ '^[0-9]+$')
      ) AS s
  ) AS fixed
 WHERE c.id = fixed.id;

-- (2) The rename and the re-key, together -- a row that moved one without the
-- other is the duplicate-minting state described above.
--
-- `properties` becomes exactly what `PersonStubBackfillService` writes for a
-- `kind='name'` participant: `{"names": ["<value_normalized>"]}`. The
-- `phones` key MUST go, not merely be joined by `names`: it is what
-- `GraphIngestService.indexIdentifiers` reads, so leaving it there would put
-- the fabricated phone identifier straight back on the next ingest that touches
-- the row. No first/middle/last parts are written or kept -- `splitPersonName`
-- reads `twitter:id:<id>` as a single token and returns none -- and none exist
-- on this corpus.
--
-- The `NOT EXISTS` guard covers the only reachable conflict: an appliance that
-- has already imported once on the fixed parser, where the occupant is the row
-- that import minted and is what the NEXT import resolves to as well. Skipping
-- is the honest outcome. Two IN-SCOPE rows cannot collide on the target: both
-- keys are functions of `name` alone, and two rows sharing a `name` would
-- already share the pre-fix `linked_id`, which `entities_linked_uniq` forbids.
UPDATE ci.entities e
   SET name = r.new_name,
       properties = (e.properties - 'phones' - 'names')
                    || jsonb_build_object('names', jsonb_build_array(r.new_name)),
       updated_at = now()
  FROM _tw_account_id_people r
 WHERE e.entity_id = r.entity_id
   AND NOT EXISTS (
         SELECT 1
           FROM ci.entities t
          WHERE t.owner_user_id IS NOT DISTINCT FROM r.owner_user_id
            AND t.entity_type = 'Person'
            AND t.linked_table = r.linked_table
            AND t.linked_id = r.new_linked_id
            AND t.entity_id <> r.entity_id);

UPDATE ci.entities e
   SET linked_id = r.new_linked_id
  FROM _tw_account_id_people r
 WHERE e.entity_id = r.entity_id
   AND e.name = r.new_name
   AND NOT EXISTS (
         SELECT 1
           FROM ci.entities t
          WHERE t.owner_user_id IS NOT DISTINCT FROM r.owner_user_id
            AND t.entity_type = 'Person'
            AND t.linked_table = r.linked_table
            AND t.linked_id = r.new_linked_id
            AND t.entity_id <> r.entity_id);

-- (3) The identifier index. The fabricated `phone` row is the artefact with
-- teeth -- `PersonLinkStage` matches `phone_last10` at 0.85 confidence -- so it
-- goes, and the `name` identifier the fixed pipeline produces replaces it.
--
-- Deleting by `entity_id` is safe and cannot take a real contact's number with
-- it: `entity_identifiers_owner_kind_value_uniq` means one row per
-- (owner, kind, value), so had the fabricated value equalled a real phone the
-- index would already have pointed at that contact and
-- `PersonStubBackfillService`'s prefilter would never have minted this stub at
-- all. Scoped to the two kinds this bug could produce, so a hand-added
-- identifier on the same row survives.
DELETE FROM ci.entity_identifiers i
 USING _tw_account_id_people r
 WHERE i.entity_id = r.entity_id
   AND (   (i.kind = 'phone' AND 'phone:' || i.value_normalized = r.old_key_tail)
        OR (i.kind = 'name'  AND i.value_normalized = r.old_name));

INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, source)
SELECT r.entity_id, r.owner_user_id, 'name', r.new_name, 'migration:20260820000332'
  FROM _tw_account_id_people r
  JOIN ci.entities e ON e.entity_id = r.entity_id AND e.name = r.new_name
ON CONFLICT (owner_user_id, kind, value_normalized) DO NOTHING;

-- (4) The search index. `ci.entities.search_vector` recomputes itself -- the
-- BEFORE UPDATE trigger `entities_search_vector_trigger` derives it from
-- `name`/`description`/`search_content`/`properties` -- but `ci_search.vectors`
-- is a separate copy, and on this corpus it holds BOTH the account id and the
-- fabricated last-ten as searchable terms ('1657380978392702976':1A
-- '8392702976':3 'phone':2). Left alone it answers to that number forever:
-- `SearchIndexBackfillService` LEFT JOINs `ci_search.embeddings` and re-indexes
-- only rows that have none, so an already-indexed row is never revisited.
--
-- Both copies are therefore dropped for the repaired rows, which puts them back
-- in the backfill's candidate set to be rewritten from the repaired entity.
-- Deleting the embedding alone would not do it: the anti-join is on
-- `embeddings`, so the stale `vectors` row would survive the re-index. There is
-- no `ci_search.index_skips` marker on any of these (checked: 0), so nothing
-- holds them out of the sweep.
DELETE FROM ci_search.embeddings em USING _tw_account_id_people r
 WHERE em.entity_id = r.entity_id
   AND EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = r.entity_id AND e.name = r.new_name);

DELETE FROM ci_search.vectors v USING _tw_account_id_people r
 WHERE v.entity_id = r.entity_id
   AND EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = r.entity_id AND e.name = r.new_name);

-- ## Idempotency
--
-- Every working set is computed once, into temp tables dropped on commit, and
-- every member leaves its own predicate the moment it is touched: a rewritten
-- participant is no longer `^[0-9]+$`, and a re-keyed entity no longer has a
-- digits-only `name` (so it is not even a candidate) nor the pre-fix
-- `linked_id`. A second run selects nothing and every statement affects zero
-- rows. Nothing already-correct is ever a candidate -- a row the fixed parser
-- created is keyed and named the way this migration ends, so it never enters
-- the set.
--
-- ## Post-migration verification
--
-- Should now be 0 -- no Twitter communication can mint a digit-named person:
--   SELECT count(*) FROM ci.communications
--    WHERE source_system = 'twitter' AND participants_metadata->>'from' ~ '^[0-9]+$';
--   SELECT count(*) FROM ci.communications c
--    WHERE c.source_system = 'twitter'
--      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(
--                    CASE WHEN jsonb_typeof(c.participants_metadata->'to')='array'
--                         THEN c.participants_metadata->'to' ELSE '[]'::jsonb END) t(v)
--                   WHERE v ~ '^[0-9]+$');
--
-- Should now be 0 -- no participant stub is named entirely of digits, and none
-- still carries a fabricated phone:
--   SELECT count(*) FROM ci.entities
--    WHERE entity_type='Person' AND linked_table='import:communications:participant'
--      AND name ~ '^[0-9]+$';
--   SELECT count(*) FROM ci.entities e JOIN ci.entity_identifiers i USING (entity_id)
--    WHERE e.linked_table='import:communications:participant' AND i.kind='phone'
--      AND e.name LIKE 'twitter:id:%';
--
-- Should be UNCHANGED -- this migration retypes nothing and deletes no entity:
--   SELECT entity_type, count(*) FROM ci.entities GROUP BY 1;
-- Likewise the ci.communications row count, and every `from_entity_id` /
-- `to_entity_ids` / `ci.relationships` reference: `entity_id` never moves.
--
-- Should now be 0 -- no dangling reference:
--   SELECT count(*) FROM ci.communications c, unnest(c.to_entity_ids) t(id)
--    WHERE NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = t.id);

-- The SET LOCAL above outlives this file's statements: dbmate records the
-- applied version in the SAME transaction, and it resolves its unqualified
-- `schema_migrations` table against the current search_path at insert time.
-- With `ci` first in the path (uuid-ossp installed into `ci`), that insert
-- targets `ci.schema_migrations`, which does not exist, and the whole
-- migration rolls back. Restore the session default before dbmate's insert.
RESET search_path;

-- migrate:down
-- No-op: irreversible data repair, same reasoning as
-- 20260819001555_repair_google_voice_participant_metadata_headings and
-- 20260819145023_rekey_google_voice_short_code_concepts. The phone numbers this
-- removes belonged to nobody, the bare id was never a name, and nothing records
-- which rows were touched versus already correct, so there is no source of
-- truth to roll back to.
