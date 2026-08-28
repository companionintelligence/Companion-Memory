-- migrate:up
-- Propose (never merge) the 2,070 Person-entity pairs -- covering 1,773 of the
-- 2,249 contact cards that 20260819092314_retype_contact_sourced_concepts_as_people
-- just re-typed -- where a re-typed card shares an EXACT name with a Person another
-- source already contributed.
--
-- ## What this adds to 20260819092314
--
-- That migration corrects the TYPE and stops there, deliberately, and its header
-- says why: a same-name match is the weakest evidence the scorer knows, so it is
-- "the worst possible basis for an irreversible write". Nothing here disagrees.
-- This migration writes no irreversible thing either -- it writes REVIEWABLE rows
-- into ci.merge_candidates, the queue whose whole contract is that a human decides.
--
-- The gap it fills is the one that header identifies and then leaves open:
--
--   "Note that the review path will not light up on its own here: `loadEvidence`
--    reads `ci.identifier_claims`, and today only the person-link legs write that
--    table, from communication/event PARTICIPANTS. These rows hold `name`-kind
--    rows in `ci.entity_identifiers` and no claims at all, so each one will be
--    swept and recorded `skipped: no_identifier_claims` until a claims producer
--    for entity-held identifiers exists."
--
-- So after the re-type these 1,773 cards are IN `DUPLICATE_DETECT_SOURCE`'s
-- candidate set and still produce nothing: 2,070 duplicate pairs that no queue
-- will ever surface, waiting on a claims producer that does not exist yet. A
-- one-shot query that reaches around `ci.identifier_claims` into the entities' own
-- names can see them today, and that is exactly the move
-- 20260818220833_propose_phone_matched_person_merge_candidates already made, for
-- the same reason, with the same evidence shape. This is that migration's
-- name-matched sibling.
--
-- Confirmed on the live QA appliance rather than inferred, using the pair that
-- motivated the original investigation:
--
--   SELECT e.entity_id, e.entity_type, e.linked_table, ei.kind, ei.value_normalized
--     FROM ci.entities e
--     LEFT JOIN ci.entity_identifiers ei ON ei.entity_id = e.entity_id
--    WHERE lower(btrim(e.name)) = 'morgan spadone';
--   -- Person  | import:linkedin | name | morgan spadone
--   -- Concept | import:vcard    |      |                 <- no identifier row AT ALL
--
-- Two independent reasons the stage cannot reach this pair, both true: the vCard
-- side holds no `ci.identifier_claims` row (092314's reason, the more fundamental
-- one), AND `entity_identifiers_owner_kind_value_uniq` is UNIQUE on
-- (owner_user_id, kind, value_normalized), so even once a claims producer exists
-- only ONE entity per owner can ever hold `name` -> 'morgan spadone' and the
-- "same claim, different entity_id" self-join still could not fire on a name.
--
-- ## Why a proposal is the ceiling here, not a step toward auto-merge
--
-- `IDENTIFIER_KIND_SCORES.name` is 0.5 and its comment says why: "display names
-- are not unique and this is the number that keeps them below any plausible
-- auto-merge floor. Two people called 'John Smith' are a QUESTION, not an answer."
-- 0.5 is also exactly `MIN_CANDIDATE_SCORE` -- "Equal to the weakest single piece
-- of evidence, so a lone name match still surfaces" -- so a name-only pair is a
-- legitimate PROPOSAL by this codebase's own rule and nothing more. This migration
-- writes that shape and touches no Person row, no name, no communication and no
-- identifier. `DuplicateDetectStage`'s rule is unchanged: CLEAN proposes; a human
-- disposes.
--
-- ## ORDERING: this must run AFTER 20260819092314
--
-- Not a preference. The `retyped` CTE identifies its subjects by the coordinate
-- 092314 moves them TO (`entity_type = 'Person'` at
-- uuidv5(ns, 'contact:' || lower(name))). Run before it, this statement matches
-- ZERO rows and inserts nothing -- silently, with no error to notice. The
-- timestamp prefix is what enforces the order, so this file was re-stamped via
-- `migrate:make` after 092314 landed rather than keeping its original
-- 20260819091554, which would have sorted first and made the whole migration a
-- no-op on any fresh database.
--
-- ## Verified against the live QA appliance, with 092314 applied first
--
--   Re-typed cards in scope                                     2249
--   Cards sharing a name with another live Person / pairs        1780 / 2112
--   After MAX_GROUP_MEMBERS <= 6                                 1773 / 2070  <- written
--   Excluded by that cap                                            7 /   42
--
--   By source of the twin (capped):
--     import:linkedin       1714
--     import:vcard           195   (the same person's handle-bearing card)
--     import:google_voice    153
--     import:contact_list      8
--                           ----
--                           2070
--
--   MAX_GROUP_MEMBERS = 6 is DuplicateDetectStage's own "stop treating this as
--   evidence" cap. Its stated rationale is a SHARED value (`info@`, a family
--   landline); the six names it excludes here are the OTHER case -- one real person
--   this appliance holds 7-9 Person rows for, across LinkedIn, vCard, Google Voice
--   and a contact list:
--
--     benjamin drolet 9, john canning 7, liam broza 7, steven berry 7,
--     steven stone 7, terrence wilburn 7
--
--   Six names, seven cards ("liam broza" is the appliance owner and holds two).
--   Applied anyway, and the cost is stated rather than hidden: 42 pairs a reviewer
--   might well have accepted. The alternative is a per-migration exception to a
--   corpus-wide evidence rule, and the queue-burial argument the cap exists for is
--   real. Those seven remain findable via `person-duplicate-names` in
--   `ci-import doctor`, which counts duplicate name groups with no cap.
--
--   Name quality: 0 of the 2,249 re-typed rows carry a name `isNonNameParticipant`
--   (graph/utils/participantSanity.ts) would refuse -- 0 embedded newlines, 0
--   call-log headings, 0 export filenames. Exactly one is phone-shaped, which that
--   predicate deliberately ALLOWS. The exclusions below are therefore no-ops on
--   this corpus, carried for the reason the phone migration carried them: a name
--   that is structurally not a name is not reviewable evidence, and this statement
--   may run on an appliance whose data is not this one.
--
--   NOTE on `\y` vs `\b`: Postgres regexes are POSIX AREs. `\y` is the word
--   boundary; `\b` matches a literal BACKSPACE and would make the call-log
--   exclusion silently match nothing -- a mistake an earlier draft of the phone
--   migration shipped and had to correct.
--
-- `uuid_generate_v5` comes from `uuid-ossp`, which is NOT provisioned by any
-- migration (`infrastructure/setup-database/entrypoint.sh` owns it) and is
-- installed into `ci` rather than `public` where present. 092314 documents this at
-- length; the same schema-resolving DO block is used here rather than assuming a
-- schema, because this file must also work when run on its own.
--
-- Idempotent: ON CONFLICT on merge_candidates' own
-- (owner_user_id, entity_type, entity_id_a, entity_id_b) unique index does
-- nothing, so a second run -- or DuplicateDetectStage later re-discovering the
-- same pair once a claims producer exists -- never duplicates a row or clobbers one
-- a human has already reviewed.
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

  -- SET LOCAL from a DO block lasts to the end of the migration's transaction, so
  -- the statement below can call `uuid_generate_v5` unqualified. It MUST be
  -- RESET before this file ends — see the RESET at the bottom of the up
  -- migration.
  EXECUTE format('SET LOCAL search_path = %I, ci, public', v5_schema);
END
$$;

WITH retyped AS (
  -- The rows 20260819092314 moved, identified by the coordinate it moved them TO.
  -- The source list mirrors that migration's exactly, deliberately: the two must
  -- agree on scope or this proposes for rows nobody re-typed.
  --
  -- Handle-absence is what made them mis-typed, and it is an exact discriminator:
  -- 0 of the 2,249 mis-typed rows carried properties->'email' or ->'phone', and 0
  -- of the correctly-typed cards lacked one. It also keeps out the 3 cards whose
  -- display name IS their own email address ("info@womp.xyz"), which sit at the
  -- same post-state coordinate but were never mis-typed.
  --
  -- Tombstones and inactive rows are excluded HERE even though 092314 re-keys them
  -- on purpose: re-keying a tombstone preserves a human's merge decision, but
  -- proposing a merge FOR a row already merged away is noise in the review queue.
  SELECT e.entity_id, e.owner_user_id, lower(btrim(e.name)) AS name_key
    FROM ci.entities e
   WHERE e.entity_type = 'Person'
     AND e.linked_table IN ('import:vcard', 'import:contact_list', 'import:apple_contacts')
     AND NOT (e.properties ? 'email' OR e.properties ? 'phone')
     AND e.owner_user_id IS NOT NULL
     AND COALESCE(e.is_active, true) = true
     AND e.merged_into_entity_id IS NULL
     AND e.name IS NOT NULL
     AND btrim(e.name) <> ''
     AND e.linked_id = uuid_generate_v5(
       '6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid, -- IMPORT_NAMESPACE, GraphIngestService.ts
       'contact:' || lower(btrim(e.name))
     )
     -- Not reviewable evidence; mirrors nonNameParticipantReason's three shapes.
     AND e.name !~ '[\r\n]'
     AND e.name !~* '^[[:space:]]*(missed|placed|received|recorded|voicemail)([[:space:]]+call)?[[:space:]]+(from|to|with)\y'
     AND e.name !~* '\.(html?|json|csv|vcf|txt)$'
     AND e.name !~* '^group conversation\y'
),
twin AS (
  -- Any other live Person of this owner's, from any source. Deliberately not
  -- restricted to `import:%`: a Person the user created by hand, or one the
  -- enrichment pass minted, is just as much the same human.
  SELECT e.entity_id, e.owner_user_id, lower(btrim(e.name)) AS name_key
    FROM ci.entities e
   WHERE e.entity_type = 'Person'
     AND e.owner_user_id IS NOT NULL
     AND COALESCE(e.is_active, true) = true
     AND e.merged_into_entity_id IS NULL
     AND e.name IS NOT NULL
     AND btrim(e.name) <> ''
     AND e.name !~ '[\r\n]'
     AND e.name !~* '^[[:space:]]*(missed|placed|received|recorded|voicemail)([[:space:]]+call)?[[:space:]]+(from|to|with)\y'
     AND e.name !~* '\.(html?|json|csv|vcf|txt)$'
     AND e.name !~* '^group conversation\y'
),
matched AS (
  -- Scoped per owner_user_id: two accounts on one appliance each knowing a "John
  -- Smith" is not a duplicate, and pairing across owners would be a data leak
  -- rather than a cleanup.
  SELECT DISTINCT r.entity_id AS r_id, t.entity_id AS t_id, r.owner_user_id, r.name_key
    FROM retyped r
    JOIN twin t
      ON t.owner_user_id = r.owner_user_id
     AND t.name_key = r.name_key
     AND t.entity_id <> r.entity_id
),
-- MAX_GROUP_MEMBERS (= 6, clean/DuplicateDetectStage.ts). The re-typed row itself
-- counts toward the group, because the stage counts DISTINCT subjects holding the
-- (kind, value) claim corpus-wide and post-re-type this row is one of them. A plain
-- GROUP BY, not `count(DISTINCT ...) OVER (...)`: Postgres does not support
-- DISTINCT inside a window function.
group_sizes AS (
  SELECT owner_user_id, name_key, count(DISTINCT t_id) + 1 AS group_size
    FROM matched
   GROUP BY 1, 2
),
pairs AS (
  SELECT m.owner_user_id,
         LEAST(m.r_id, m.t_id)    AS entity_id_a, -- CHECK (entity_id_a < entity_id_b)
         GREATEST(m.r_id, m.t_id) AS entity_id_b,
         m.name_key
    FROM matched m
    JOIN group_sizes g
      ON g.owner_user_id = m.owner_user_id
     AND g.name_key = m.name_key
   WHERE g.group_size <= 6
)
INSERT INTO ci.merge_candidates (
  owner_user_id, entity_type, entity_id_a, entity_id_b,
  score, evidence, detected_by, detector_version
)
SELECT owner_user_id,
       'Person',
       entity_id_a,
       entity_id_b,
       0.5, -- IDENTIFIER_KIND_SCORES.name, clean/DuplicateDetectStage.ts
       jsonb_build_array(jsonb_build_object('kind', 'name', 'value', name_key, 'score', 0.5)),
       'migration:20260819145716_propose_contact_card_person_name_merge_candidates',
       0 -- not a DuplicateDetectStage generation number; see the note above on why
         -- that stage cannot reach these pairs on its own
  FROM pairs
ON CONFLICT (owner_user_id, entity_type, entity_id_a, entity_id_b) DO NOTHING;

-- ## Post-migration verification
--
--   SELECT count(*) FROM ci.merge_candidates
--    WHERE detected_by = 'migration:20260819145716_propose_contact_card_person_name_merge_candidates';
--   -- <= 2070 (ON CONFLICT DO NOTHING may skip a pair already proposed under the
--   -- same ordered entity_id_a/entity_id_b)
--
--   -- A zero here means the ordering guarantee above was violated -- 092314 has not
--   -- run, so there are no re-typed Person rows to match. It does NOT mean the
--   -- corpus is clean.
--
--   -- Every proposed pair should be two live Persons with the same name, one of
--   -- them a contact card:
--   SELECT a.name, a.linked_table, b.name, b.linked_table
--     FROM ci.merge_candidates mc
--     JOIN ci.entities a ON a.entity_id = mc.entity_id_a
--     JOIN ci.entities b ON b.entity_id = mc.entity_id_b
--    WHERE mc.detected_by = 'migration:20260819145716_propose_contact_card_person_name_merge_candidates'
--    LIMIT 20;

-- The SET LOCAL above outlives this file's statements: dbmate records the
-- applied version in the SAME transaction, and it resolves its unqualified
-- `schema_migrations` table against the current search_path at insert time.
-- With `ci` first in the path (uuid-ossp installed into `ci`), that insert
-- targets `ci.schema_migrations`, which does not exist, and the whole
-- migration rolls back. Restore the session default before dbmate's insert.
RESET search_path;

-- migrate:down
-- Only this migration's own proposals, and only the ones still untouched: a human's
-- accept/reject is a decision, not a side effect of a schema change, and
-- `merge_candidates_status_check` keeps 'accepted'/'rejected' distinguishable from
-- 'pending' precisely so a rollback can leave them alone. An accepted pair's merge
-- is PersonMergeService's to undo, not this file's.
DELETE FROM ci.merge_candidates
 WHERE detected_by = 'migration:20260819145716_propose_contact_card_person_name_merge_candidates'
   AND status = 'pending';
