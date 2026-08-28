-- migrate:up

-- Bring the Google Voice participants that landed as `Concept` into line with
-- what the fixed parser now produces: re-key the SMS short codes, and drop the
-- call-log headings that were never participants at all.
--
-- ## The bug this cleans up after
--
-- `resolveEntityType` (`domains/import/staging/identity.ts`) infers 'contact'
-- only from an attribute long enough to be a HANDLE (an email, or seven digits
-- and up). `datasources/googlevoice.ts` staged two of its three participant
-- pushes with no `type` of its own, so any participant whose only attribute was
-- a shorter number resolved to a NULL type and `push/entities.ts entityTypeFor`
-- filed it under `DEFAULT_ENTITY_TYPE` = `Concept`. 147 rows on one QA corpus,
-- 143 on another. This is the same defect class PR #2131 fixed for `vcard.ts` /
-- `contactlist.ts` / `applecontacts.ts`, in a parser those three did not cover.
--
-- ## Why this is NOT 20260819092314
--
-- That migration repaired the same fall-through by retyping the rows to
-- `Person`, and its own scope note names these rows as ones it must NOT reach:
-- "`import:google_voice` SMS short codes". The reason is that a vCard IS a
-- contact card, while a Google Voice thread is a MESSAGE LOG whose other end is
-- not a person by construction. 142 of the 147 rows here are exactly that:
-- three-to-six digit short codes -- "411", "99217", "227898", "+411" -- the
-- numbers services text from. One of them reads
--
--   SprintFreeMsg LAGUNA NIGUEL POLICE DEPT ... 911 EMERG
--
-- Making "411" a `Person` would put it in the address book, in the person
-- search index and in `DUPLICATE_DETECT_SOURCE`'s candidate set, and nothing
-- downstream would object: `isNonNameParticipant` deliberately lets a bare
-- number through ("a short handle, a bare phone number, a single token -- all
-- still pass"). So the ENTITY TYPE these rows already hold is correct and this
-- migration does not change a single one.
--
-- What it changes is the KEY, and that is the half of 20260819092314's lesson
-- that still applies. `naturalKeyFor` folds the staged type into the key and
-- `GraphIngestService` derives `linked_id = uuidv5(key, IMPORT_NAMESPACE)` from
-- it, so a row minted type-less keyed as `entity:<name>` while the fixed
-- parser's declared `short_code` keys as `short_code:<name>`. Leaving the key
-- alone would let the very next import mint a SECOND `Concept` for every short
-- code that already has one. Moving it makes each row byte-for-byte the row the
-- fixed parser would have created, so a re-import is find-and-return. Nothing
-- else about these rows differs: `name`, `entity_type` and `properties`
-- (`{"names": ["411"]}`) are already what a post-fix import writes.
--
-- Rows already tombstoned by a merge are included on purpose: `upsertEntities`
-- resolves a coordinate THROUGH `merged_into_entity_id` (`canonicalIdOf`), so
-- re-keying a tombstone preserves the human's merge decision against future
-- imports of the same short code instead of letting it come back as a new row.
--
-- ## The other five rows
--
-- The remainder are not short codes and not participants: their whole name is a
-- bare call-log heading with the trailing newline still attached -- "Received
-- call from\n", "Voicemail from\n", "Placed call to\n", "Recorded call with\n",
-- "Missed call from\n". They are the `Concept`-typed siblings of the population
-- 20260819002002 repaired, and they survived it only because that migration
-- scopes on `entity_type = 'Person'`.
--
-- Under that migration's own classification they are the DROP case: no strong
-- identifier (their only `ci.entity_identifiers` row is kind 'name', holding
-- the heading itself), and not recoverable -- stripping the heading leaves the
-- empty string, because the export named nobody. So they are dropped here
-- exactly as it drops its own, and nothing re-creates them: `extractSender`
-- already applies `stripCallLogHeading` and returns no name at all for these,
-- and 20260819001555 has already removed the same heading from
-- `participants_metadata` (all 134 affected rows carry `{"from": "Recorded call
-- with"}`, which that migration deletes the key for), so no relinking sweep has
-- a string left to mint from either. Deleting the output of a generator that is
-- still running is theatre; the generator is off on both sides.
--
-- ## Deliberately NOT done
--
-- A Google Voice `Concept` that is NEITHER a short code NOR a heading would, by
-- the fixed parser, be a name-only participant and therefore a `contact` ->
-- `Person`. No such row exists on either QA corpus (147 = 142 + 5, and
-- 143 = 142 + 1), and it is not reachable from the message push at all, whose
-- participant map is keyed by phone. Such a row is left alone rather than
-- promoted, because the short code that would be promoted with it is
-- indistinguishable from here: a short code's number is NOT stored anywhere on
-- the row (`normalizeHandle` refuses it, so it reaches neither `identityKey`
-- nor `properties.phone`), so all this migration can read is the name. A
-- missed re-key costs one duplicate `Concept` that is visible and repairable; a
-- wrong promotion silently files a service as a person, which is the exact harm
-- the parser change exists to prevent.
--
-- The two predicates below are written to exclude each other, and a row that
-- somehow satisfied BOTH -- a short code that kept a trailing newline, so it
-- reads as a heading by the newline test and as a short code once trimmed -- is
-- left alone rather than guessed at. Repairing one would need a THIRD write,
-- the rename to the string `extractSender` now produces, and neither QA corpus
-- holds such a row (all five newline rows carry no digit at all). Doing
-- nothing costs one duplicate; doing half of it leaves a row that matches
-- neither the old shape nor the new one.
--
-- ## Scope
--
-- `linked_table` names the source system. Within it, the `linked_id` equality
-- is the load-bearing half: it is only true of a row whose key WAS
-- `entity:<lower(trimmed name)>`, i.e. one minted type-less by the pre-fix
-- path. It matched 147 of 147 candidates on one QA corpus and 143 of 143 on the
-- other, which is what makes the scope provable rather than asserted.
--
-- The short-code predicate is `isShortCode` from
-- `domains/import/staging/identity.ts` restated in SQL: phone-shaped (digits
-- and the punctuation phone numbers are written with, nothing else) and holding
-- between one and six digits -- one fewer than `normalizeHandle`'s seven, which
-- is the single threshold both sides read.
--
-- The namespace literal below is `IMPORT_NAMESPACE` from
-- `GraphIngestService.ts` ("Do not change -- it is the idempotency anchor");
-- `push/__tests__/googleVoiceShortCodeMigration.test.ts` fails if this file and
-- that constant, `naturalKeyFor`, `entityTypeFor` or the parser's declared type
-- ever disagree.

-- `uuid-ossp` supplies the only RFC-4122 v5 (SHA-1) generator available to SQL:
-- PostgreSQL 18 ships `uuidv4`/`uuidv7` builtins and no v5, and `sha1` itself
-- lives in an extension too. It is provisioned per-appliance rather than by a
-- migration (`infrastructure/setup-database/entrypoint.sh`), so it may be
-- absent, and where it is present it is installed into `ci` rather than
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
  -- file ends — see the RESET at the bottom of the up migration.
  EXECUTE format('SET LOCAL search_path = %I, ci, public', v5_schema);
END
$$;

-- The working set, computed ONCE. `btrim` is given an explicit character list
-- because its default trims spaces only, and the heading rows end in a newline
-- -- which is also why they key on the TRIMMED name: `naturalKeyFor` trims
-- before it lowercases, while `ci.entities.name` keeps the parser's raw string.
CREATE TEMP TABLE _gv_concept_repair ON COMMIT DROP AS
SELECT e.entity_id,
       e.owner_user_id,
       e.linked_table,
       -- Phone-shaped with one to six digits: `isShortCode`, in SQL.
       (btrim(e.name, E' \t\r\n') ~ '^[-+()./[:space:]0-9]+$'
        AND length(regexp_replace(e.name, '[^0-9]', '', 'g')) BETWEEN 1 AND 6) AS short_code,
       (e.name ~ '[\r\n]'
        OR e.name ~* '^[[:space:]]*(missed|placed|received|recorded|voicemail)([[:space:]]+call)?[[:space:]]+(from|to|with)\y') AS heading,
       uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                        'short_code:' || lower(btrim(e.name, E' \t\r\n'))) AS new_linked_id
  FROM ci.entities e
 WHERE e.entity_type = 'Concept'
   AND e.linked_table = 'import:google_voice'
   AND e.name IS NOT NULL
   AND e.linked_id = uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                                      'entity:' || lower(btrim(e.name, E' \t\r\n')));

CREATE INDEX ON _gv_concept_repair (entity_id);

-- (1) Re-key every short code whose post-fix coordinate is free.
--
-- No tie-break is needed for two in-scope rows wanting the same target, and it
-- is worth saying why rather than writing a `DISTINCT ON` that can never fire:
-- both keys are functions of `lower(btrim(name))` alone, so two rows that would
-- collide on the post-fix key already collide on the PRE-fix one -- and
-- `entities_linked_uniq` means the database never stored the second of them.
-- The only reachable conflict is with a row that is NOT in scope, which is what
-- the `NOT EXISTS` tests for: one way to get there is an appliance that has
-- already imported once on the fixed parser, so the occupant is the row that
-- import minted and is what the NEXT import will resolve to as well. Skipping
-- is the honest outcome, and it risks no third row.
UPDATE ci.entities e
   SET linked_id  = r.new_linked_id,
       updated_at = now()
  FROM _gv_concept_repair r
 WHERE e.entity_id = r.entity_id
   AND r.short_code
   AND NOT r.heading
   AND NOT EXISTS (
         SELECT 1
           FROM ci.entities t
          WHERE t.owner_user_id IS NOT DISTINCT FROM r.owner_user_id
            AND t.entity_type = 'Concept'
            AND t.linked_table = r.linked_table
            AND t.linked_id = r.new_linked_id
            AND t.entity_id <> r.entity_id);

-- (2) The heading rows are not participants. Un-set them as a sender and remove
-- them from every recipient list first, exactly as 20260819002002 does for its
-- own DROP population. `array_agg` collapses to NULL when the last element
-- goes, which is the "no recipient resolved" shape `PersonLinkStage` and
-- `CommunicationParticipantLinkListener` already treat as unresolved.
--
-- On both QA corpora `to_entity_ids` holds none of these (the affected rows are
-- 134 senders and zero recipients); the statement is written anyway, because
-- "the shape that was corrupted once" is a poor scope for a repair.
CREATE TEMP TABLE _gv_concept_doomed ON COMMIT DROP AS
SELECT entity_id FROM _gv_concept_repair WHERE heading AND NOT short_code;

CREATE INDEX ON _gv_concept_doomed (entity_id);

UPDATE ci.communications c
   SET to_entity_ids = (
         SELECT array_agg(id) FROM unnest(c.to_entity_ids) AS id
          WHERE id NOT IN (SELECT entity_id FROM _gv_concept_doomed)
       )
 WHERE c.to_entity_ids && (SELECT array_agg(entity_id) FROM _gv_concept_doomed);

UPDATE ci.communications c
   SET from_entity_id = NULL
  FROM _gv_concept_doomed d
 WHERE c.from_entity_id = d.entity_id;

-- (3) Everything hanging off a heading row, then the row. Audited across EVERY
-- *entity_id column in the ci/ci_search schemas on a real appliance database:
-- only `communications.from_entity_id` (134), `entity_identifiers` (1, kind
-- 'name' holding the heading) and `graph_deltas` (5) reference them at all.
-- Zero in relationships, events, position, receipts, inventory, devices,
-- identifier_claims, merge_candidates, entity_merge_blocks, entity_merges,
-- users, pipeline_state, pipeline_dead_letters and every ci_search table --
-- `Concept` is not an indexable type, so there is no `concept` row in
-- `ci_search.vectors` or `ci_search.embeddings` to begin with. The deletes
-- below are still written for the tables that could hold one, because an entity
-- being removed has no business keeping a ledger row on another appliance.
--
-- `ci.graph_deltas` is an append-only change LOG with no foreign key to
-- ci.entities. Its rows record that these entities were once created; rewriting
-- history to hide a repair would be worse than a log entry pointing at a row
-- that no longer exists -- which is already the state 20260818220731 left
-- behind. Left alone deliberately, as 20260819002002 leaves it.
DELETE FROM ci.entity_identifiers ei USING _gv_concept_doomed d WHERE ei.entity_id = d.entity_id;

DELETE FROM ci.pipeline_state ps USING _gv_concept_doomed d WHERE ps.entity_id = d.entity_id;

DELETE FROM ci_search.embeddings emb USING _gv_concept_doomed d WHERE emb.entity_id = d.entity_id;

DELETE FROM ci_search.vectors v USING _gv_concept_doomed d WHERE v.entity_id = d.entity_id;

DELETE FROM ci.entities e USING _gv_concept_doomed d WHERE e.entity_id = d.entity_id;

-- ## Idempotency
--
-- The working set is computed once, into a temp table dropped on commit, as
-- 20260819002002 and 20260818174213 do. Every member leaves the predicate the
-- moment it is touched -- a re-keyed short code no longer satisfies the
-- `linked_id = uuidv5('entity:' || ...)` equality, and a dropped heading row no
-- longer exists -- so a second run selects nothing and every statement affects
-- zero rows. Nothing already-correct is ever a candidate: a row keyed the way
-- the fixed parser keys it is not in the working set at all.
--
-- ## Post-migration verification
--
-- Should now be 0 -- no Google Voice Concept still carries the pre-fix key:
--   SELECT count(*) FROM ci.entities
--    WHERE entity_type = 'Concept' AND linked_table = 'import:google_voice'
--      AND linked_id = uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
--                                       'entity:' || lower(btrim(name, E' \t\r\n')));
--
-- Should now be 0 -- no Google Voice CONCEPT is named after a bare heading.
-- Scoped to `Concept` on purpose: the `Person` rows of the same shape belong to
-- 20260819002002, and an appliance that has not run it yet still holds 2,353 of
-- them, which would make an unscoped check read as a failure of this migration:
--   SELECT count(*) FROM ci.entities
--    WHERE entity_type = 'Concept' AND linked_table = 'import:google_voice'
--      AND name ~ '[\r\n]';
--
-- Should now be 0 -- no dangling reference survives:
--   SELECT count(*) FROM ci.communications c, unnest(c.to_entity_ids) t(id)
--    WHERE NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = t.id);
--   SELECT count(*) FROM ci.communications c
--    WHERE c.from_entity_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = c.from_entity_id);
--
-- Should be UNCHANGED -- this migration retypes nothing:
--   SELECT entity_type, count(*) FROM ci.entities GROUP BY 1;
-- (`Concept` loses exactly the 5 heading rows; every other type is untouched.)
-- ci.communications row count is unchanged.

-- The SET LOCAL above outlives this file's statements: dbmate records the
-- applied version in the SAME transaction, and it resolves its unqualified
-- `schema_migrations` table against the current search_path at insert time.
-- With `ci` first in the path (uuid-ossp installed into `ci`), that insert
-- targets `ci.schema_migrations`, which does not exist, and the whole
-- migration rolls back. Restore the session default before dbmate's insert.
RESET search_path;

-- migrate:down

-- Irreversible by design, on both halves. Every re-keyed row is afterwards
-- indistinguishable from a row the FIXED parser minted correctly, which is the
-- whole point of moving `linked_id`; a down migration keyed on the post-fix
-- coordinate would drag those correct rows back to the pre-fix key and
-- re-create the bug on any appliance that has imported since. The dropped rows
-- carried a call-log heading and nothing else, and nothing records which rows
-- were touched versus already clean, so there is no source of truth to roll
-- back to.
SELECT 1;
