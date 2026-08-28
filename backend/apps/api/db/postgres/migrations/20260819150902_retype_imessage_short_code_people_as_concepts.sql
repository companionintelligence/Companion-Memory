-- migrate:up

-- Take the SMS short codes that the iMessage import filed as `Person` out of
-- the address book: retype them to `Concept`, re-key them to the coordinate the
-- fixed parser now mints, and delete the person-search rows they should never
-- have had.
--
-- ## The bug this cleans up after
--
-- `datasources/imessage.ts contactEntity` declared `type: 'contact'` for every
-- `handle.id` in chat.db, and `push/entities.ts entityTypeFor` maps 'contact'
-- to `Person`. chat.db does not distinguish a person's line from the number a
-- service texts from, so every 2FA sender, alert service and directory-
-- assistance code the owner has ever been messaged by landed as a person: 269
-- rows on the QA corpus, named "888222", "72524", "9119", "457", "1112".
--
-- Nothing downstream objected, by design. `isNonNameParticipant`
-- (`domains/graph/utils/participantSanity.ts`) deliberately lets a bare number
-- through -- "a short handle, a bare phone number, a single token -- all still
-- pass" -- so a `Person` named "411" reached the address book, the person
-- search index and `DUPLICATE_DETECT_SOURCE`'s candidate set unchallenged.
--
-- The forward fix is the `short_code` type `contactEntity` now declares for a
-- handle `isShortCode` recognises. It deliberately repairs nothing that already
-- landed, which is this migration.
--
-- ## How this differs from the two migrations it is modelled on
--
-- 20260819092314 (vCard `Concept` -> `Person`) and 20260819145023 (Google Voice
-- short codes, re-key only) both repaired a type that fell through
-- `resolveEntityType` for want of a declared one. This parser always declared a
-- type; it declared the WRONG one. Three consequences follow, and each is a
-- place where copying either predecessor verbatim would be wrong.
--
-- 1. The pre-fix key is `contact:<name>`, not `entity:<name>`. Both
--    predecessors scope on the `entity:` prefix as proof that a row was minted
--    type-less, and no row here carries it. What stands in for that proof is
--    the SHAPE OF THE NAME: `naturalKeyFor` falls back to the name only when
--    `identityKey` is null, and `entityIdentityKey` refuses anything
--    `normalizeHandle` will not key -- fewer than seven digits. So a row keyed
--    `contact:<its own short-code name>` is one whose handle was refused, which
--    is exactly the population the parser now types differently. Verified, not
--    assumed: 269 of 269 candidates on the QA corpus carry that key, 0 carry
--    `entity:`, none has a `phones` entry in `properties`, and none has a
--    `phone`-kind row in `ci.entity_identifiers`.
--
-- 2. The type MUST move, unlike the Google Voice half of this defect, where the
--    fall-through had already landed on `Concept` by accident and only the key
--    was wrong. Here `Person` is the thing being fixed.
--
-- 3. Because the type moves, the search index has to be dismantled -- see
--    below. Neither predecessor had a single index row to delete, because
--    `Concept` is not an indexable type and both were repairing rows that were
--    already `Concept`s.
--
-- ## Why RETYPE and not delete
--
-- These are real correspondents, not junk: 2,622 communications on the QA
-- corpus have one as their `from_entity_id` and 19 more list one in
-- `to_entity_ids`. A short code is a thing worth having a node for that is
-- neither a person nor a place, which is what `DEFAULT_ENTITY_TYPE` =
-- `Concept` is documented to mean, and what the Google Voice short codes on the
-- same corpus already are. The entity_id does not move, so every one of those
-- 2,641 references stays valid and no communication loses its counterpart.
--
-- `ci.entity_identifiers` is left alone for the same reason. Its 212 rows here
-- are all kind 'name' holding the code itself, which is precisely what the 142
-- already-correct `import:google_voice` short-code `Concept`s carry -- 142 of
-- 142, all kind 'name'. (The 57-row shortfall is a pre-existing collision, not
-- damage this migration should repair: every one of the 57 has its
-- (owner, 'name', value) slot held by a DIFFERENT entity, so
-- `entity_identifiers_owner_kind_value_uniq` refused the second writer.)
--
-- ## Why the linked_id moves too
--
-- `naturalKeyFor` folds the staged type into the key, and `GraphIngestService`
-- derives `linked_id = uuidv5(key, IMPORT_NAMESPACE)` from it. The same handle
-- that keyed as `contact:411` before the parser fix keys as `short_code:411`
-- after it, and `coordKey` -- (entity_type, linked_table, linked_id) -- differs
-- from the existing row in BOTH of its interesting components.
--
-- Retyping alone would therefore heal the corpus and let the very next import
-- re-break it: the fixed parser would resolve to no existing row and mint a
-- SECOND entity for a code that already has one, this time a `Concept`
-- alongside the `Person` it did not find. Moving `linked_id` makes each
-- repaired row byte-for-byte the row the fixed parser would have created, so a
-- re-import is find-and-return. Nothing else about these rows differs from
-- what a post-fix import writes: `name`, `properties` (`{"names": ["411"]}`)
-- and the NULL `first_name`/`last_name` already match, and `properties` holds
-- no `phones` entry to strip because `identityHandles` never accepted the
-- number in the first place.
--
-- Rows already tombstoned by a merge are included on purpose: `upsertEntities`
-- resolves a coordinate THROUGH `merged_into_entity_id` (`canonicalIdOf`), so
-- re-keying a tombstone preserves the human's merge decision against future
-- imports of the same short code instead of letting it come back as a new row.
-- The QA corpus has none.
--
-- ## Why the index rows are deleted
--
-- This is the half neither predecessor needed, and it is the half that makes
-- the repair worth running: a `Person` IS indexed. All 269 rows carry a
-- `ci_search.vectors` row (`entity_type = 'person'`), a `ci_search.embeddings`
-- row, and two `ci.pipeline_state` ledger rows apiece -- `index.vector_person`
-- and `index.embed_person`, both 'done'.
--
-- Nothing removes them on its own. `INDEX_EMBED_PERSON_SOURCE` and its vector
-- twin select `s.entity_type = 'Person'`, so the moment the row becomes a
-- `Concept` the sweep stops seeing it -- it will neither refresh the index rows
-- nor notice they exist. `ci_search.vectors` is the search CANDIDATE source, so
-- left behind they would answer person searches for "888222" forever, pointing
-- at a row that is no longer a person: the exact harm the parser change exists
-- to prevent, surviving the fix that was supposed to end it.
--
-- The `ci.pipeline_state` rows go with them because the ledger is what
-- `selectStale` anti-joins against. Leaving them would record that a stage
-- which can no longer see this row has finished with it, which is a claim about
-- a row that no longer exists in that stage's world.
--
-- `ci_search.index_skips` is deleted for the same reason. The QA corpus holds
-- none for these rows, but it is an index-side ledger keyed on
-- (entity_type, entity_id) and an entity leaving `Person` has no business
-- keeping one.
--
-- ## Deliberately NOT done
--
-- No search re-index is scheduled. A `Concept` has no indexable form -- there
-- is no `concept` row in `ci_search.vectors` at all, on this corpus or any
-- other -- so there is nothing to re-index INTO, which is why the 142
-- already-correct Google Voice short codes carry zero vectors, zero embeddings
-- and zero pipeline_state rows. Deleting is the whole of the work.
--
-- `ci.graph_deltas` is left alone. It is an append-only change LOG with no
-- foreign key to ci.entities; its 269 rows record that these entities were once
-- created, and rewriting history to hide a repair would be worse than a log
-- that says what happened. 20260819002002 and 20260819145023 leave it for the
-- same reason.
--
-- The 2 short-code `Person`s under `linked_table =
-- 'import:communications:participant'` are out of scope. They have a different
-- producer -- `PersonStubBackfillService`, which mints a stub from
-- `participants_metadata` when a communication resolved no correspondent -- and
-- a different key, so this migration's scope predicate cannot reach them and
-- should not: repairing them without fixing that service would be a backfill
-- undone by its own minter.
--
-- ## Scope
--
-- `linked_table` names the source system. Within it the two halves are the
-- short-code SHAPE of the name and the `linked_id` equality, and they are
-- load-bearing together: the equality is only true of a row whose key WAS
-- `contact:<lower(trimmed name)>`, i.e. one whose handle `normalizeHandle`
-- refused, and the shape is what says the refused handle was a number rather
-- than an empty or malformed one. A real contact is unreachable by both --
-- it keys on its HANDLE, not its name -- and matched 0 of the corpus.
--
-- The short-code predicate is `isShortCode` from
-- `domains/import/staging/identity.ts` restated in SQL: phone-shaped (digits
-- and the punctuation phone numbers are written with, nothing else) and holding
-- between one and six digits -- one fewer than `normalizeHandle`'s seven, which
-- is the single threshold both sides read. It matched 269 of 269 candidates on
-- the QA corpus, which is what makes the scope provable rather than asserted.
--
-- The namespace literal below is `IMPORT_NAMESPACE` from
-- `GraphIngestService.ts` ("Do not change -- it is the idempotency anchor");
-- `push/__tests__/imessageShortCodeMigration.test.ts` fails if this file and
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

-- The working set, computed ONCE, before anything moves. Every statement below
-- reads it rather than re-deriving the predicate, so the index deletes cannot
-- disagree with the retype about which rows are in scope.
--
-- `btrim` is given an explicit character list because its default trims spaces
-- only, and the key is computed from the TRIMMED name: `naturalKeyFor` trims
-- before it lowercases, while `ci.entities.name` keeps the parser's raw string.
CREATE TEMP TABLE _im_short_code_repair ON COMMIT DROP AS
SELECT e.entity_id,
       e.owner_user_id,
       e.linked_table,
       uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                        'short_code:' || lower(btrim(e.name, E' \t\r\n'))) AS new_linked_id
  FROM ci.entities e
 WHERE e.entity_type = 'Person'
   AND e.linked_table = 'import:imessage'
   AND e.name IS NOT NULL
   -- Phone-shaped with one to six digits: `isShortCode`, in SQL.
   AND btrim(e.name, E' \t\r\n') ~ '^[-+()./[:space:]0-9]+$'
   AND length(regexp_replace(e.name, '[^0-9]', '', 'g')) BETWEEN 1 AND 6
   AND e.linked_id = uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                                      'contact:' || lower(btrim(e.name, E' \t\r\n')));

CREATE INDEX ON _im_short_code_repair (entity_id);

-- Drop from the working set anything whose post-fix coordinate is already
-- taken, BEFORE any write -- so a row that cannot be re-keyed is not half
-- repaired by the index deletes either.
--
-- No tie-break is needed for two in-scope rows wanting the same target, and it
-- is worth saying why rather than writing a `DISTINCT ON` that can never fire:
-- both keys are functions of `lower(btrim(name))` alone, so two rows that would
-- collide on the post-fix key already collide on the PRE-fix one -- same
-- owner, same `Person`, same `linked_table`, same `linked_id` -- and
-- `entities_linked_uniq` means the database never stored the second of them.
--
-- The only reachable conflict is with a row that is NOT in scope: an appliance
-- that has already imported once on the fixed parser, so the `Concept` at that
-- coordinate is the row that import minted and is what the NEXT import will
-- resolve to as well. Skipping is the honest outcome there, and it risks no
-- third row. It leaves a `Person` named after a short code, which is visible
-- and repairable; the alternative is a constraint violation that fails the
-- whole migration for every other appliance.
DELETE FROM _im_short_code_repair r
 WHERE EXISTS (
         SELECT 1
           FROM ci.entities t
          WHERE t.owner_user_id IS NOT DISTINCT FROM r.owner_user_id
            AND t.entity_type = 'Concept'
            AND t.linked_table = r.linked_table
            AND t.linked_id = r.new_linked_id
            AND t.entity_id <> r.entity_id);

-- (1) Retype AND re-key. Both halves in one statement: a row that got only one
-- of them would match neither the old shape nor the new one.
UPDATE ci.entities e
   SET entity_type = 'Concept',
       linked_id   = r.new_linked_id,
       updated_at  = now()
  FROM _im_short_code_repair r
 WHERE e.entity_id = r.entity_id;

-- (2) Dismantle the person-search index for the rows that just stopped being
-- people. Ordered after the retype so a failure here leaves rows that are
-- already out of the address book rather than rows that are still in it with
-- their index gone.
DELETE FROM ci_search.vectors v USING _im_short_code_repair r WHERE v.entity_id = r.entity_id;

DELETE FROM ci_search.embeddings emb USING _im_short_code_repair r WHERE emb.entity_id = r.entity_id;

DELETE FROM ci_search.index_skips s USING _im_short_code_repair r WHERE s.entity_id = r.entity_id;

DELETE FROM ci.pipeline_state ps USING _im_short_code_repair r WHERE ps.entity_id = r.entity_id;

DELETE FROM ci.pipeline_dead_letters dl USING _im_short_code_repair r WHERE dl.entity_id = r.entity_id;

-- ## Idempotency
--
-- The working set is computed once, into a temp table dropped on commit, as
-- 20260819145023 and 20260819002002 do. Every member leaves the predicate the
-- moment it is touched -- a repaired row is neither `Person` nor keyed
-- `contact:<name>` any more, and either half alone would exclude it -- so a
-- second run selects nothing and every statement affects zero rows. Nothing
-- already-correct is ever a candidate: a row keyed and typed the way the fixed
-- parser writes it is not in the working set at all.
--
-- ## Post-migration verification
--
-- Should now be 0 -- no iMessage short code is still a Person:
--   SELECT count(*) FROM ci.entities
--    WHERE entity_type = 'Person' AND linked_table = 'import:imessage'
--      AND btrim(name, E' \t\r\n') ~ '^[-+()./[:space:]0-9]+$'
--      AND length(regexp_replace(name, '[^0-9]', '', 'g')) BETWEEN 1 AND 6;
--
-- Should now be 0 -- and this is the one that would silently stay broken:
-- no person-search row survives for an entity that is no longer a Person.
--   SELECT count(*) FROM ci_search.vectors v
--     JOIN ci.entities e ON e.entity_id = v.entity_id
--    WHERE v.entity_type = 'person' AND e.entity_type <> 'Person';
--
-- Should be UNCHANGED -- the entity_id never moves, so no communication loses
-- its counterpart, and this migration deletes no entity and no communication:
--   SELECT count(*) FROM ci.communications WHERE from_entity_id IS NOT NULL;
--   SELECT count(*) FROM ci.communications;
--   SELECT count(*) FROM ci.entities;
-- (`ci.entities` keeps every row; `Person` loses exactly what `Concept` gains.)
--
-- Should now be 0 -- no dangling reference was created:
--   SELECT count(*) FROM ci.communications c
--    WHERE c.from_entity_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = c.from_entity_id);

-- The SET LOCAL above outlives this file's statements: dbmate records the
-- applied version in the SAME transaction, and it resolves its unqualified
-- `schema_migrations` table against the current search_path at insert time.
-- With `ci` first in the path (uuid-ossp installed into `ci`), that insert
-- targets `ci.schema_migrations`, which does not exist, and the whole
-- migration rolls back. Restore the session default before dbmate's insert.
RESET search_path;

-- migrate:down

-- Irreversible by design. Every repaired row is afterwards indistinguishable
-- from a row the FIXED parser minted correctly, which is the whole point of
-- moving `linked_id`; a down migration keyed on the post-fix coordinate would
-- drag those correct rows back to `Person` and to the pre-fix key, re-creating
-- the bug on any appliance that has imported since. The deleted index rows are
-- derived data with no record of which were deleted versus never present, and
-- re-creating them would mean re-embedding rows that are no longer people.
SELECT 1;
