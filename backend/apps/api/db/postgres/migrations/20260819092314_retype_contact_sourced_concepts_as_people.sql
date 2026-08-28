-- migrate:up

-- Repair the contact cards that the import filed as `Concept` instead of
-- `Person`, and re-key them to the natural key the fixed parsers now mint.
--
-- ## The bug this cleans up after
--
-- `resolveEntityType` (`domains/import/staging/identity.ts`) infers 'contact'
-- only from a phone/email ATTRIBUTE, via `hasContactIdentity`. The three contact
-- parsers — `datasources/vcard.ts`, `contactlist.ts`, `applecontacts.ts` —
-- never declared a `type` of their own, so a card carrying nothing but a name
-- resolved to a NULL type and `push/entities.ts entityTypeFor` filed it under
-- `DEFAULT_ENTITY_TYPE` = `Concept`. Most cards in a real export are exactly
-- that: one Google Takeout `.vcf` contributed 4,926 of them, listing a name and
-- a LinkedIn URL and nothing else.
--
-- The forward fix is the `type: 'contact'` those three parsers now declare
-- (2026-08-19). It deliberately repairs nothing that already landed, which is
-- this migration.
--
-- ## Why RETYPE and not merge
--
-- 1,777 of the 2,244 rows on the QA corpus share a name with an existing
-- `Person`, so the tempting repair is to collapse them into it. That is exactly
-- what `DuplicateDetectStage` refuses to do — "it proposes and a human
-- disposes" — because `PersonMergeService` re-points identifiers,
-- communications, events and relationships and then deletes embeddings, and
-- unpicking that is a migration rather than an undo. A same-NAME match is the
-- weakest evidence the scorer knows (0.5, "two people called John Smith are a
-- QUESTION, not an answer"), which makes it the worst possible basis for an
-- irreversible write.
--
-- So this migration only corrects the type. That is a fact about the FORMAT the
-- row was parsed from — a vCard is a contact card — and it is decidable without
-- guessing about identity. What it leaves behind is an ordinary Person-vs-Person
-- duplicate, which is a shape the system already has a review path for.
--
-- Note that the review path will not light up on its own here: `loadEvidence`
-- reads `ci.identifier_claims`, and today only the person-link legs write that
-- table, from communication/event PARTICIPANTS. These rows hold `name`-kind
-- rows in `ci.entity_identifiers` and no claims at all, so each one will be
-- swept and recorded `skipped: no_identifier_claims` until a claims producer
-- for entity-held identifiers exists. The retype still puts them IN the
-- candidate set (`DUPLICATE_DETECT_SOURCE` selects `entity_type = 'Person'`),
-- which as `Concept`s they were never in.
--
-- ## Why the linked_id moves too
--
-- `naturalKeyFor` folds the STAGED type into the key: a handle-less entity keys
-- as `<type>:<lower(name)>`, and `GraphIngestService` derives
-- `linked_id = uuidv5(key, IMPORT_NAMESPACE)` from it. So the same card that
-- keyed as `entity:john doe` before the parser fix keys as `contact:john doe`
-- after it, and the ingest idempotency coordinate — (owner_user_id,
-- entity_type, linked_table, linked_id) — differs from the existing row in BOTH
-- of its interesting components.
--
-- Retyping alone would therefore heal the corpus and let the very next import
-- re-break it: the fixed parser would resolve to no existing row and mint a
-- SECOND `Person` for a card that already has one. Moving `linked_id` to the
-- post-fix key makes each repaired row byte-for-byte the row the fixed parser
-- would have created, so a re-import is find-and-return. Nothing else about
-- these rows differs from their handle-bearing siblings: `name`, `properties`
-- (`Source`/`Files`/`Names`/`names`) and the NULL `first_name`/`last_name` are
-- already exactly what a post-fix import writes.
--
-- Rows already tombstoned by a merge are included on purpose: `upsertEntities`
-- resolves a coordinate THROUGH `merged_into_entity_id` (`canonicalIdOf`), so
-- re-keying a tombstone preserves the human's merge decision against future
-- imports of the same card instead of letting it come back as a new row.
--
-- ## Scope
--
-- `linked_table` names the source system, so it selects exactly the three
-- parsers and cannot reach the `Concept`s that legitimately exist —
-- `import:uber` menu items ("Regular Burrito Bowl"), `import:google_voice` SMS
-- short codes. The `linked_id` equality is the load-bearing half: it is only
-- true of a row whose key WAS `entity:<lower(name)>`, i.e. one minted
-- handle-less and type-less by the pre-fix path. It matched 2,244 of 2,244
-- candidates on one QA corpus and 2,249 of 2,249 on another, and it is what
-- makes the scope provable rather than asserted.
--
-- The namespace literal below is `IMPORT_NAMESPACE` from
-- `GraphIngestService.ts` ("Do not change — it is the idempotency anchor");
-- `__tests__/importNamespaceContract.spec.ts` fails if this file and that
-- constant ever disagree. `uuid_generate_v5` here is byte-identical to the
-- `uuid` package's `v5`, verified on ASCII and non-ASCII keys.

-- `uuid-ossp` supplies the only RFC-4122 v5 (SHA-1) generator available to SQL:
-- PostgreSQL 18 ships `uuidv4`/`uuidv7` builtins and no v5, and `sha1` itself
-- lives in an extension too. It is provisioned per-appliance rather than by a
-- migration (`infrastructure/setup-database/entrypoint.sh`), so it may be
-- absent, and where it is present it is installed into `ci` rather than
-- `public` — hence resolving its schema instead of assuming one. It is a
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

-- Pass 1: retype AND re-key, for every row whose post-fix coordinate is free.
--
-- No tie-break is needed for two in-scope rows wanting the same target, and it
-- is worth saying why rather than writing a `DISTINCT ON` that can never fire:
-- both keys are functions of `lower(btrim(name))` alone, so two rows that would
-- collide on the post-fix key already collide on the PRE-fix one — and
-- `entities_linked_uniq` means the database never stored the second of them.
-- The only reachable conflict is with a row that is NOT in scope, which is what
-- the `NOT EXISTS` below tests for.
WITH scoped AS (
  SELECT e.entity_id,
         e.owner_user_id,
         e.linked_table,
         uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                          'contact:' || lower(btrim(e.name))) AS new_linked_id
    FROM ci.entities e
   WHERE e.entity_type = 'Concept'
     AND e.linked_table IN ('import:vcard', 'import:contact_list', 'import:apple_contacts')
     AND e.name IS NOT NULL
     AND e.linked_id = uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                                        'entity:' || lower(btrim(e.name)))
),
claimable AS (
  SELECT s.entity_id,
         s.new_linked_id
    FROM scoped s
   WHERE NOT EXISTS (
           SELECT 1
             FROM ci.entities t
            WHERE t.owner_user_id IS NOT DISTINCT FROM s.owner_user_id
              AND t.entity_type = 'Person'
              AND t.linked_table = s.linked_table
              AND t.linked_id = s.new_linked_id)
)
UPDATE ci.entities e
   SET entity_type = 'Person',
       linked_id   = c.new_linked_id,
       updated_at  = now()
  FROM claimable c
 WHERE e.entity_id = c.entity_id;

-- Pass 2: retype the rows pass 1 could not re-key.
--
-- One way to get here: an appliance that imported once already on the fixed
-- parsers, so the post-fix coordinate is taken by the row that import minted.
-- That is not a reason to leave a contact card typed as a `Concept`, and it
-- risks no third row — the occupant is what the next import resolves to. What
-- is left behind is a Person-vs-Person duplicate, the same thing every other
-- row this migration touches leaves behind.
--
-- The `NOT EXISTS` re-check is against this row's OWN key: it can only fire if
-- some other row already sits at (owner, 'Person', linked_table, linked_id),
-- which would make the retype violate `entities_linked_uniq`. Skipping is the
-- honest outcome there; nothing else in this migration can create that state.
UPDATE ci.entities e
   SET entity_type = 'Person',
       updated_at  = now()
 WHERE e.entity_type = 'Concept'
   AND e.linked_table IN ('import:vcard', 'import:contact_list', 'import:apple_contacts')
   AND e.name IS NOT NULL
   AND e.linked_id = uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                                      'entity:' || lower(btrim(e.name)))
   AND NOT EXISTS (
         SELECT 1
           FROM ci.entities t
          WHERE t.owner_user_id IS NOT DISTINCT FROM e.owner_user_id
            AND t.entity_type = 'Person'
            AND t.linked_table = e.linked_table
            AND t.linked_id = e.linked_id);

-- No search re-index is scheduled here, and none is needed. `ci_search.vectors`
-- and `ci_search.embeddings` hold nothing for these rows (a `Concept` is not an
-- indexable type — there is no `concept` vector in the corpus), and
-- `ci.pipeline_state` holds no ledger row for them either, so
-- `index.vector_person` / `index.embed_person` see 2,244 fresh candidates the
-- next time their sweep runs: `selectStale` is an anti-join against the ledger
-- over `entity_type = 'Person'`, not a created_at watermark, so an old row that
-- becomes eligible is picked up like a new one. `ci.entity_identifiers` needs
-- no repair either — it carries no entity_type — and `search_vector` is derived
-- from name/description/search_content/properties, none of which move here.

-- The SET LOCAL above outlives this file's statements: dbmate records the
-- applied version in the SAME transaction, and it resolves its unqualified
-- `schema_migrations` table against the current search_path at insert time.
-- With `ci` first in the path (uuid-ossp installed into `ci`), that insert
-- targets `ci.schema_migrations`, which does not exist, and the whole
-- migration rolls back. Restore the session default before dbmate's insert.
RESET search_path;

-- migrate:down

-- Irreversible by design. The reverse of this is not "put the type back": every
-- row this touched is indistinguishable, afterwards, from a row the FIXED
-- parsers minted correctly, which is the whole point of moving `linked_id`. A
-- down migration keyed on the post-fix coordinate would demote those correct
-- rows to `Concept` too and re-create the bug on any appliance that has
-- imported since. The pre-fix state is not worth restoring at that price.
SELECT 1;
