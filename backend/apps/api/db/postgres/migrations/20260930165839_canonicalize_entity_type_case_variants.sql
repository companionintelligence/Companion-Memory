-- migrate:up

-- Spell every case variant of a known graph entity type the way the rest of the
-- system reads it: `PERSON` becomes `Person`, `CONCEPT` becomes `Concept`.
--
-- ## Where these rows came from
--
-- `memory.remember` (WriteKnowledgeTool) wrote `entity_type` exactly as the
-- model spelled it, on `entity.create` and on a real retype in `entity.update`.
-- The tool now sends a known type in its canonical spelling
-- (`canonicalEntityType`, domains/memory/graph.types.ts). This repairs what it
-- wrote before that.
--
-- ## Why there are no LOWER-case rows to repair
--
-- The spelling Qwen actually sends — `person`, `place` — never reached a row.
-- `valid_entity_type CHECK (entity_type ~ '^[A-Z][A-Za-z]*$')` has been on
-- ci.entities since the table was created (20250925144000) and no migration has
-- dropped it, so each of those writes failed its statement and the job
-- dead-lettered, update and all, after the tool had answered "Created". Those
-- writes are in `ci.pipeline_dead_letters`, not here. The write path now folds
-- the spelling too (GraphUtilityService.createOrUpdateNode), so replaying one
-- from the jobs page lands it.
--
-- What the CHECK lets through is a variant with a capital first letter —
-- `PERSON`, `PerSon`. PersonService (a TypeORM STI child repository, so
-- `entity_type = 'Person'` exactly), the person search sweeps and
-- `entities_linked_uniq` all read that as a type of its own. The tool keeps a
-- row's stored spelling when a later write names the same type in another case,
-- so without this nothing would ever correct one.
--
-- ## Why RE-TYPE and not re-key
--
-- The retype migrations this follows (20260819092314, 20260819150902) had to
-- move `linked_id` as well. The importer derives it from a natural key that
-- folds in the parser's STAGED type (`naturalKeyFor`), and those fixes changed
-- that type. Here nothing derives a key from the spelling being repaired.
-- GraphIngestService's `linked_id` is `uuidv5(key)` over the parsers' own
-- vocabulary, and the agent tool never mints one: a row carries the linked key
-- its import gave it, or the one the model sent, or none. So correcting
-- `entity_type` alone puts each row exactly where the fixed tool would have put
-- it, and an importer upserting on (owner_user_id, entity_type, linked_table,
-- linked_id) finds it there.
--
-- ## Scope
--
-- Only an exact case variant of a type in ENTITY_TYPES (graph.types.ts, as of
-- this migration). A type the graph does not know (`RESTAURANT`) is left as it
-- is, because its spelling is the caller's. So is another NAME for a known type:
-- a `Contact` is not a misspelt `Person`, and moving it would move its import
-- key.
--
-- Rows already tombstoned by a merge are included, as in 20260819092314:
-- `upsertEntities` resolves a coordinate THROUGH `merged_into_entity_id`, so a
-- tombstone on its canonical key goes on redirecting imports to its survivor.
--
-- ## Collisions
--
-- A row with a linked key can only move where `entities_linked_uniq` has room:
-- - When the canonical twin already holds the key (a Concept retyped to
--   `PERSON` beside the `Person` its card was also imported as), the twin keeps
--   it and the variant stays as it is. The two are a duplicate pair for a human
--   to settle — the tool now refuses that retype and names the twin — not for a
--   migration to merge.
-- - When two variants want one key, the active one, then the older, takes it.
-- A row with no linked key is outside the index and always moves.
--
-- ## What does not need repairing
--
-- - Search. A variant row was never indexed: GraphEventListener lower-cases the
--   type and re-emits PersonCreatedEvent and the like, but the index listener
--   reads the row back through the per-type service, which cannot see it. Once
--   the row is a Person the person sweeps pick it up — `selectStale` anti-joins
--   its ledger within `entity_type = 'Person'`, so a row falling INTO that
--   predicate is found like a new one. A Concept or a Place is indexed on its
--   next write. Nothing is orphaned: that trap (20260819150902) is a retype OUT
--   of Person.
-- - `ci.entity_identifiers` has no entity_type column.
-- - `ci.relationships.from_entity_type` / `to_entity_type`: the agent's edge
--   write leaves them NULL, and the importer stamps its own canonical types.
WITH known (entity_type) AS (
  VALUES ('Person'), ('Pet'), ('Group'), ('Concept'), ('Location'), ('Object'), ('Event'),
         ('Goal'), ('File'), ('Place'), ('Contact'), ('Content'), ('Communication'), ('Item'),
         ('Thing'), ('Product'), ('Tag'), ('Organization')
),
variants AS (
  SELECT e.entity_id,
         e.owner_user_id,
         e.linked_table,
         e.linked_id,
         k.entity_type AS canonical_type,
         row_number() OVER (
           PARTITION BY e.owner_user_id, k.entity_type, e.linked_table, e.linked_id
           ORDER BY e.is_active DESC, e.created_at, e.entity_id
         ) AS claim_order
    FROM ci.entities e
    JOIN known k ON lower(e.entity_type) = lower(k.entity_type)
   WHERE e.entity_type <> k.entity_type
)
UPDATE ci.entities e
   SET entity_type = v.canonical_type,
       updated_at  = now()
  FROM variants v
 WHERE e.entity_id = v.entity_id
   AND (v.linked_table IS NULL
        OR (v.claim_order = 1
            AND NOT EXISTS (
                  SELECT 1
                    FROM ci.entities t
                   WHERE t.owner_user_id IS NOT DISTINCT FROM v.owner_user_id
                     AND t.entity_type = v.canonical_type
                     AND t.linked_table = v.linked_table
                     AND t.linked_id = v.linked_id)));

-- migrate:down

-- Irreversible by design. Afterwards a repaired row is indistinguishable from
-- one written correctly, so a down migration could only guess which `Person`
-- to demote back to `PERSON` — and the spelling it would restore is the bug.
SELECT 1;
