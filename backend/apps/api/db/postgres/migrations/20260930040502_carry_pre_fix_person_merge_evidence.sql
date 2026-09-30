-- migrate:up

-- Carry the evidence of every Person merge made before PersonMergeService
-- carried it itself: re-point each merged-away source's identifier claims to
-- the person it was merged into, and record its merge blocks for that person.
--
-- ## The bug this cleans up after
--
-- Until 2026-09-29 `PersonMergeService.repointReferences` re-pointed
-- `ci.entity_identifiers` and left two things on the tombstone:
--
--  (a) `ci.identifier_claims.entity_id`. Every claim that resolved to the
--      source still names the tombstone: the self claims
--      `enrich.person_self_claim` derived from the source's card, and the
--      from/to/participant claims `enrich.person_link` resolved to it.
--      `DuplicateDetectStage.loadEvidence` joins holders to LIVE people only,
--      so that evidence stopped counting anywhere. A third copy that shares
--      nothing but the merged-away card's address or number is never proposed
--      against the survivor. Nothing moves the claims later either:
--      the self-claim stage skips tombstones, and the link stages re-resolve a
--      message only when their version is bumped.
--
--  (b) `ci.entity_merge_blocks`. A human's "these two are NOT the same person"
--      about the source stayed with the tombstone, where nothing reads it.
--      This is the dangerous half. The survivor gets re-examined with the
--      source's evidence, by (a)'s repair below or by the pending
--      `enrich.person_self_claim` / `clean.duplicate_detect` version bumps,
--      which re-derive every survivor's self claims from its folded card. At
--      that point the detector can propose (survivor, X) where the human
--      blocked (source, X). If a shared address evidences the pair,
--      `MergeCandidateService.autoMergeDeterministicPairs` then merges it
--      without asking anyone.
--
-- The fix (#2818) makes every merge do both inside its own transaction and
-- counts them in the audit row (`details.counts.claims` / `.blocksCarried`).
-- It repairs no merge that had already happened. This migration does.
--
-- ## Ship WITH or AFTER that fix, and WITH or BEFORE the first bump
--
-- A merge made between this migration and the fix would strand its evidence
-- again, and dbmate never re-runs a migration. Every statement here is
-- idempotent, so running the migrate:up half again by hand is safe; do it in
-- ONE transaction, because the working table is ON COMMIT DROP. The first
-- self-claim or detector version bump (#2797 at the time of writing)
-- re-examines every survivor, so it must find the blocks already carried.
--
-- ## Where a tombstone's evidence goes: its canonical live Person
--
-- A tombstone's `merged_into_entity_id` is followed to the end of its chain.
-- `PersonMergeService` re-points every tombstone at the new survivor (path
-- compression, #1840, 2026-08-05), so a merge made since is one hop. A chain
-- made before that can be longer. Its first hop is then another tombstone,
-- where evidence counts no more than on the first. The walk is bounded at 32
-- hops, so a cycle (which no merge path can make) still terminates; it simply
-- resolves to nobody.
--
-- The chain has to still stand. Every row on it must still be a Person of the
-- same owner, and the row it ends at must be live: active and not merged,
-- which is the definition the detector and the review queue both use. A chain
-- that fails any of that resolves to nobody, and its evidence stays where it
-- is:
--
--  * a source a later repair retyped out of Person. A short code's number is
--    not evidence about the person it had been merged into;
--  * a chain through a row retyped out of Person, or ending at a person who
--    was deleted, or crossing into another owner's rows.
--
-- Places and objects have their own merge services, which touch neither table.
-- Like the fix, this repairs Person merges only.
--
-- ## 1. Blocks, first
--
-- A block with an endpoint that resolves above is recorded again between the
-- canonical endpoints. Either end may be the tombstone; so may both. An
-- endpoint that is not a tombstone keeps its id, as the merge itself treats
-- it. A block with a tombstone endpoint that resolves to nobody is left
-- alone.
-- A pair that collapses to one person is not carried: the merge was the later
-- decision, if a person made it. The auto-merge drain may have made it
-- instead, acting past the very block this migration carries, and nothing
-- records which (see "Blocks the merges collapsed" at the end).
-- LEAST/GREATEST meets `entity_merge_blocks_ordered` (a < b).
-- Several blocks can land on one canonical pair, and the earliest one's reason
-- is carried. A block the pair already holds keeps its own (ON CONFLICT DO
-- NOTHING): the first "no" carries the intent, as `EntityMergeBlockService`
-- says. The original row stays, because it is what an unmerge replays
-- (entity-merge.md §5.4).
--
-- Inside one transaction the order of the statements is invisible to anyone
-- else. Blocks still come first because that is the order that is safe, and a
-- reader should not have to work out that here it happens not to matter.
--
-- ## 2. Claims
--
-- Only `entity_id` moves. Everything else stays exactly as it is: the
-- observation (`subject_type` / `subject_id`, `role`, the values), how it was
-- decided (`method`, `confidence`) and a human's `disposition`. The move
-- cannot collide, because `identifier_claims_observation_uniq` does not
-- include `entity_id`. A `rejected` claim moves too and stays rejected. Every
-- reader excludes rejected claims, whoever they name, and
-- `enrich.person_link`'s own upsert would move one the same way, through
-- `ci.entity_identifiers`.
--
-- ## 3. Re-open the detector for the survivors that gained claims
--
-- `clean.duplicate_detect` decided each of those survivors without the claims
-- step 2 just gave it, and nothing re-offers a decided row except a version
-- bump. So each survivor whose claims moved has its detector row re-opened,
-- exactly as `PipelineStateService.reopen()` does it: `stage_version = 0` on a
-- `done` or `skipped` row. A failed row has its own retry gate. Note the key:
-- the detector's ledger rows say `entity_type = 'entity'`, not 'Person' (the
-- four Person stages use three spellings).
--
-- `enrich.person_self_claim` is NOT re-opened. It reads the survivor's
-- `properties`, which nothing here touches. And the source's self claims (the
-- values it would re-derive from the folded card) are among the claims step 2
-- moved onto the survivor.
--
-- Nor are the historical `ci.entity_merges` rows stamped with
-- `details.counts.blocksCarried` so that `IdentifierArrivalService` re-opens
-- their survivors. Those merges carried nothing, and the audit row is what an
-- unmerge replays. And that service dates its re-open from the MERGE's
-- `created_at`, while for these merges the evidence arrives now. A survivor
-- re-decided between its merge and today would be skipped.
--
-- ## Idempotent
--
-- A second run finds no claim on a tombstone that resolves, so it moves
-- nothing and re-opens nothing, and every block it would carry already
-- exists.

CREATE TEMP TABLE _merge_evidence_canonical ON COMMIT DROP AS
WITH RECURSIVE chain AS (
  SELECT t.entity_id             AS tombstone_id,
         t.owner_user_id,
         t.merged_into_entity_id AS reached,
         1                       AS hops
    FROM ci.entities t
   WHERE t.merged_into_entity_id IS NOT NULL
     AND t.entity_type = 'Person'
  UNION ALL
  SELECT chain.tombstone_id,
         chain.owner_user_id,
         n.merged_into_entity_id,
         chain.hops + 1
    FROM chain
    JOIN ci.entities n
      ON n.entity_id = chain.reached
     AND n.owner_user_id = chain.owner_user_id
     AND n.entity_type = 'Person'
     AND n.merged_into_entity_id IS NOT NULL
   WHERE chain.hops < 32
)
SELECT chain.tombstone_id,
       chain.owner_user_id,
       chain.reached AS canonical_id
  FROM chain
  JOIN ci.entities c
    ON c.entity_id = chain.reached
   AND c.owner_user_id = chain.owner_user_id
   AND c.entity_type = 'Person'
   AND c.merged_into_entity_id IS NULL
   AND COALESCE(c.is_active, true) = true;

-- A temp table has no statistics until it is analyzed, and without them the
-- claims UPDATE below may hash-join the whole of ci.identifier_claims instead
-- of probing identifier_claims_entity_idx once per tombstone.
ANALYZE _merge_evidence_canonical;

-- 1. Blocks.
INSERT INTO ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b, reason)
SELECT DISTINCT ON (carried.owner_user_id, carried.entity_id_a, carried.entity_id_b)
       carried.owner_user_id,
       carried.entity_id_a,
       carried.entity_id_b,
       carried.reason
  FROM (
         SELECT b.owner_user_id,
                LEAST(COALESCE(ca.canonical_id, b.entity_id_a),
                      COALESCE(cb.canonical_id, b.entity_id_b))    AS entity_id_a,
                GREATEST(COALESCE(ca.canonical_id, b.entity_id_a),
                         COALESCE(cb.canonical_id, b.entity_id_b)) AS entity_id_b,
                b.reason,
                b.created_at,
                b.block_id
           FROM ci.entity_merge_blocks b
           LEFT JOIN _merge_evidence_canonical ca
             ON ca.tombstone_id = b.entity_id_a
            AND ca.owner_user_id = b.owner_user_id
           LEFT JOIN _merge_evidence_canonical cb
             ON cb.tombstone_id = b.entity_id_b
            AND cb.owner_user_id = b.owner_user_id
           LEFT JOIN ci.entities ea ON ea.entity_id = b.entity_id_a
           LEFT JOIN ci.entities eb ON eb.entity_id = b.entity_id_b
          WHERE (ca.canonical_id IS NOT NULL OR cb.canonical_id IS NOT NULL)
            AND (ea.merged_into_entity_id IS NULL OR ca.canonical_id IS NOT NULL)
            AND (eb.merged_into_entity_id IS NULL OR cb.canonical_id IS NOT NULL)
       ) carried
 WHERE carried.entity_id_a <> carried.entity_id_b
 ORDER BY carried.owner_user_id, carried.entity_id_a, carried.entity_id_b,
          carried.created_at, carried.block_id
    ON CONFLICT (owner_user_id, entity_id_a, entity_id_b) DO NOTHING;

-- 2 and 3. Claims, then the detector rows of the survivors they moved to.
WITH moved AS (
  UPDATE ci.identifier_claims c
     SET entity_id = m.canonical_id
    FROM _merge_evidence_canonical m
   WHERE c.entity_id = m.tombstone_id
     AND c.owner_user_id = m.owner_user_id
  RETURNING c.entity_id
)
UPDATE ci.pipeline_state ps
   SET stage_version = 0,
       updated_at    = now()
 WHERE ps.entity_type = 'entity'
   AND ps.stage = 'clean.duplicate_detect'
   AND ps.entity_id IN (SELECT moved.entity_id FROM moved)
   AND ps.status IN ('done', 'skipped')
   AND ps.stage_version > 0;

DROP TABLE _merge_evidence_canonical;

-- ## Blocks the merges collapsed: for a person to review
--
-- Step 1 skips a block whose two ends now resolve to ONE person. That is right
-- when a person merged them after saying no. But
-- `MergeCandidateService.autoMergeDeterministicPairs` could have merged them
-- too: it checks a block only on the exact pair, so a "no" left on a
-- tombstone never stopped it. And nothing records which of the two made a
-- merge, because both call `PersonMergeService.mergePeople` and mark the
-- candidate accepted. The read-only query below lists these blocks, with the
-- latest merge of either blocked record, for a person to judge; an empty
-- result means there is nothing to judge. It follows one hop, as every reader
-- does, and path compression (#1840) makes that exact for merges made since.
--
--   SELECT b.owner_user_id, b.entity_id_a, b.entity_id_b, b.reason,
--          b.created_at AS blocked_at,
--          COALESCE(ea.merged_into_entity_id, ea.entity_id) AS now_one_person,
--          (SELECT max(m.created_at)
--             FROM ci.entity_merges m
--            WHERE m.owner_user_id = b.owner_user_id
--              AND m.source_entity_id IN (b.entity_id_a, b.entity_id_b)) AS last_merged_at
--     FROM ci.entity_merge_blocks b
--     JOIN ci.entities ea ON ea.entity_id = b.entity_id_a AND ea.entity_type = 'Person'
--     JOIN ci.entities eb ON eb.entity_id = b.entity_id_b AND eb.entity_type = 'Person'
--    WHERE COALESCE(ea.merged_into_entity_id, ea.entity_id)
--        = COALESCE(eb.merged_into_entity_id, eb.entity_id)
--    ORDER BY b.created_at;

-- migrate:down

-- No-op: irreversible data repair. Moving a claim back onto a tombstone, or
-- dropping a carried block, would restore the defect this fixes. Nothing
-- records where the moved claims pointed before, and no original block was
-- removed, so there is nothing to put back.
