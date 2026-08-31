-- migrate:up

-- Re-open the file index stages whose ledger says `done` but whose index row is
-- gone, so the pipeline rebuilds what the orphan sweep deleted.
--
-- Companion to the code fix in
-- backend/apps/api/src/domains/search-ingress/entitySourceMap.ts.
--
-- WHAT HAPPENED
--
-- `ENTITY_SOURCE_MAP.file` resolved to `ci.entities` / `entity_id` with
-- `entity_type = 'File'` — the file's GRAPH NODE — while every writer of
-- `entity_type = 'file'` index rows keys on `ci.files.id`
-- (`FileSearchIndexListener`, `FileEmbedStage`, `FileVectorStage`). The two
-- tables are 1:1 but their ids are disjoint: GraphIngest mints a fresh
-- `entity_id` instead of reusing the file's uuid. On this appliance, 7,775 File
-- nodes vs 12,823 `ci.files` rows, ZERO id overlap.
--
-- So `OrphanCleanupService`'s existence check ("does a `ci.entities` row with
-- this id and entity_type='File' exist?") was false for every file index row
-- ever written, and `OrphanCleanupCron` deleted the entire `file` index each
-- night at 02:50. Measured here: the pipeline wrote 7,775 embeddings and 7,775
-- vectors between 07:40 and 09:25 UTC on 2026-08-30, the sweep ran at 09:50:35
-- UTC, and `ci_search.{embeddings,vectors}` now hold 0 rows of entity_type
-- 'file'.
--
-- WHY THE CODE FIX ALONE IS NOT ENOUGH
--
-- `ci.pipeline_state` still carries 7,775 `index.embed_file` and 7,775
-- `index.vector_file` rows at status `done` and the current `stage_version`.
-- That is precisely the state `PipelineStateService.claim()` refuses to
-- re-claim, so with the map fixed the sweep would stop deleting — and the
-- 7,775 files would simply stay unsearchable forever, silently. Deleting the
-- ledger row is what makes them candidates again on the next
-- `PipelineTickCron` tick; the stages then re-embed and re-vectorize them, and
-- with the fixed map the sweep leaves the result alone.
--
-- WHY DELETE RATHER THAN BUMP THE STAGE VERSION
--
-- A version bump in `versions.ts` would re-run BOTH stages over every file on
-- every appliance, including the ones that are fine. This targets exactly the
-- rows whose ledger disagrees with the index, so on an appliance that never ran
-- the broken sweep it deletes nothing and costs one index-served anti-join.
--
-- WHY ONLY `status = 'done'`
--
-- `done` is the only status that implies a row was actually written:
-- `DenseEmbedStageBase` records `skipped` (reason `empty` /
-- `source_row_missing` / `embed_type_disabled`) for anything it declined, and
-- `failed` / `quarantined` are owned by the retry gate and by a human. Widening
-- this would re-open decisions the pipeline made deliberately.
--
-- Idempotent and re-runnable: once the stages have rebuilt the index, the
-- anti-join matches nothing.

-- Dense embeddings: `index.embed_file` writes ci_search.embeddings.
DELETE FROM ci.pipeline_state ps
 WHERE ps.entity_type = 'file'
   AND ps.stage = 'index.embed_file'
   AND ps.status = 'done'
   AND NOT EXISTS (
     SELECT 1
       FROM ci_search.embeddings e
      WHERE e.entity_type = 'file'
        AND e.entity_id = ps.entity_id
   );

-- Lexical vectors: `index.vector_file` writes ci_search.vectors. A separate
-- statement, not one pass over both stages, because the stage each row belongs
-- to decides WHICH index table proves it was written — the two halves were
-- deleted independently and can be missing independently.
DELETE FROM ci.pipeline_state ps
 WHERE ps.entity_type = 'file'
   AND ps.stage = 'index.vector_file'
   AND ps.status = 'done'
   AND NOT EXISTS (
     SELECT 1
       FROM ci_search.vectors v
      WHERE v.entity_type = 'file'
        AND v.entity_id = ps.entity_id
   );

-- migrate:down

-- No-op, deliberately. This deleted ledger rows that asserted work which no
-- longer exists; re-inserting them would re-assert the same false claim and
-- re-hide the missing index from the pipeline. Rolling back the code fix alone
-- restores the old (broken) behaviour, which is all a `down` can honestly mean
-- here.
