-- migrate:up

-- Re-open the edge legs' decisions for rows whose linkage was filled in AFTER
-- the leg had projected them, so the pipeline projects the edges it missed.
--
-- Companion to the code fix: `EDGE_PROJECTION_REOPENER`
-- (backend/apps/api/src/domains/maintenance/edgeProjectionReopener.ts) and the
-- `enrich.person_link` / `enrich.event_person_link` entries in `STAGE_REOPENS`
-- (backend/apps/api/src/domains/pipeline/reopens.ts).
--
-- WHAT HAPPENED
--
-- `promote.edge_communication` projects `ci.communications.from_entity_id` /
-- `to_entity_ids` into SENT / RECEIVED edges and records `done`. THE ONE RULE
-- never offers that row again at the same version. Its predicate is an OR
-- (sender, recipients, attachments), so a message is decided on whichever
-- arrives first, and a column filled in afterwards is never projected. The
-- late writer was almost always `CommunicationLinkBackfillService`, the
-- `link_communications` leg smart-rotation's `graph_link` runs every two hours.
-- It fills only the columns that are still empty, and it re-opened nothing.
--
-- Measured on the reference appliance 2026-09-30, read-only, with the
-- projection's own endpoint resolution (merge tombstone, active-or-merged, no
-- self edge): 17,417 communications at `done` on version 7 (the leg's version
-- then) were missing 19,889 RECEIVED and 1,456 SENT edges. 17,416 of them had no
-- `enrich.person_link` ledger row at all, and none had an inactive SENT or
-- RECEIVED edge. Nearly every one had an edge of ANOTHER type, projected by
-- the same slice from what was already there (one half of the linkage, or an
-- attachment). On the import of 2026-09-29 (times UTC): Twitter DMs were
-- decided on their ATTACHED_TO edge at 19:41. WhatsApp messages the owner sent
-- were decided on their RECEIVED edge at 19:41-19:46. Google Voice texts were
-- decided on their SENT edge at 22:11-23:09. The missing half was filled by
-- the `graph_link` runs archived at 21:05 and 23:08. The one remaining message
-- was `enrich.person_link` adding 56 people 18 minutes after its decision.
--
-- Five more appeared on 2026-09-30 at 15:23 from a different writer: a person
-- merge racing the projection. See the `PersonMergeService` residual in
-- `reopens.ts`. They are the same state, so this repairs them too.
--
-- WHY THE CODE FIX ALONE IS NOT ENOUGH
--
-- It re-opens decisions for links written from now on. The rows already
-- stranded stay `done` at the current version, which is exactly the state
-- `PipelineStateService.claim()` refuses to re-claim.
--
-- AND THE VERSION-8 BUMP
--
-- `PERSON_LINK_VERSION` 3 moved both edge legs to version 8, so the first
-- deploy carrying it re-projects every row once, including rows stranded at 7.
-- That bump does not stop the stranding, though. Until this fix is deployed,
-- every `graph_link` run keeps linking late, and each one strands fresh rows at
-- 8. This migration catches those. On an appliance that takes the bump and
-- this fix in one deploy, the rows it re-opens are already stale and it costs
-- one scan.
--
-- WHY A TARGETED RE-OPEN RATHER THAN A VERSION BUMP
--
-- The edge legs' versions derive from `EDGE_PROJECTION_RULE_GENERATION`, and
-- the projection rule did not change. A bump would re-project every row of
-- every edge leg on every appliance, for rows most of which are complete. This
-- selects exactly the rows whose ledger says `done` while an edge the
-- projection WOULD write for their current linkage is absent. On an appliance
-- that never hit the gap it matches nothing.
--
-- It re-opens (`stage_version` back to 0, the value a fresh claim carries,
-- `status` and `reason` kept) rather than deleting the ledger row. That is
-- what `PipelineStateService.reopen()` does at runtime, so a row repaired here
-- and a row the fixed writers re-open look the same afterwards. The next
-- hourly sweep of each leg re-projects them. The projection is `ON CONFLICT DO
-- NOTHING`, so the edges a row already has are not written twice.
--
-- WHICH RULES
--
-- Only rules whose inputs have a LATE writer:
--   communication.sent / .received   from_entity_id / to_entity_ids
--                                    (person_link, the maintenance linkers)
--   event.organized / .participated  organizer / participant_entity_ids
--                                    (event_person_link, link_events)
--   event.happened_at                location_entity_id
--                                    (promote.place, GeocodeBatchListener;
--                                    re-opened at runtime since STAGE_REOPENS)
-- Attachment rules (0 missing on the reference) and parent_event_id are
-- written at ingest.
--
-- Only `done` / `skipped` rows above version 0, as in `reopen()`: `running` is
-- a live claim, `failed` / `quarantined` already have their own gate, and a
-- row with no ledger row is already a candidate.
--
-- Idempotent and re-runnable: once the legs have re-projected, nothing
-- matches.
--
-- DRY RUN (a pg_dump copy of the reference appliance, 2026-09-30): re-opened
-- 17,422 communication decisions and 0 event ones. Re-projecting them through
-- the real worker and `promote.edge_communication` wrote exactly the 21,350
-- missing edges (19,890 RECEIVED, 1,460 SENT, each with its graph delta) in
-- 24 s. The gap then measured 0, and a second run of this migration updated
-- nothing.

-- Communications. ci.relationships is probed through its directed partial
-- unique index (from, to, type) WHERE is_active.
WITH decided AS (
  SELECT ps.entity_id AS id
    FROM ci.pipeline_state ps
   WHERE ps.entity_type = 'communication'
     AND ps.stage = 'promote.edge_communication'
     AND ps.status IN ('done', 'skipped')
     AND ps.stage_version > 0
),
-- One pass over ci.communications, both rules per row (a UNION of two
-- scans measured 2.3x slower on the 327k-message reference corpus).
--
-- MATERIALIZED is load-bearing, not a hint. Inlined, the planner may drive
-- the entity lookups from the lateral pairs and scan EVERY entity of the owner
-- once per message. It picks that plan when `ci.entities` has no statistics,
-- which is the state right after a restore or a `pg_upgrade`, exactly when
-- migrations run. Measured on a restored copy of the reference corpus (652k
-- entities, on a heavily loaded machine): with no statistics the inlined
-- form was cancelled after 10 minutes and the materialized one took 31 s;
-- with statistics, 21 s against 10 s. Materialized pairs get a primary-key
-- lookup whatever the statistics say.
pairs AS MATERIALIZED (
  SELECT c.id AS source_id, c.user_id, p.from_raw, c.id AS to_raw, p.relationship_type
    FROM decided d
    JOIN ci.communications c ON c.id = d.id
    CROSS JOIN LATERAL (
      SELECT unnest(c.to_entity_ids) AS from_raw, 'RECEIVED'::text AS relationship_type
      UNION ALL
      SELECT c.from_entity_id, 'SENT' WHERE c.from_entity_id IS NOT NULL
    ) p
),
missing AS (
  SELECT DISTINCT p.source_id
    FROM pairs p
    JOIN ci.entities ef
      ON ef.entity_id = p.from_raw
     AND ef.owner_user_id = p.user_id
     AND (ef.is_active = TRUE OR ef.merged_into_entity_id IS NOT NULL)
    JOIN ci.entities et
      ON et.entity_id = p.to_raw
     AND et.owner_user_id = p.user_id
     AND (et.is_active = TRUE OR et.merged_into_entity_id IS NOT NULL)
   WHERE COALESCE(ef.merged_into_entity_id, ef.entity_id)
         <> COALESCE(et.merged_into_entity_id, et.entity_id)
     AND NOT EXISTS (
       SELECT 1
         FROM ci.relationships r
        WHERE r.from_entity_id = COALESCE(ef.merged_into_entity_id, ef.entity_id)
          AND r.to_entity_id = COALESCE(et.merged_into_entity_id, et.entity_id)
          AND r.relationship_type = p.relationship_type
          AND r.is_active = TRUE
     )
)
UPDATE ci.pipeline_state ps
   SET stage_version = 0,
       updated_at    = now()
  FROM missing m
 WHERE ps.entity_type = 'communication'
   AND ps.stage = 'promote.edge_communication'
   AND ps.entity_id = m.source_id
   AND ps.status IN ('done', 'skipped')
   AND ps.stage_version > 0;

-- Events. Same shape, three rules. `event.happened_at` stores LOCATED_AT
-- (HAPPENED_AT is a write alias), from the event to its place.
WITH decided AS (
  SELECT ps.entity_id AS id
    FROM ci.pipeline_state ps
   WHERE ps.entity_type = 'event'
     AND ps.stage = 'promote.edge_event'
     AND ps.status IN ('done', 'skipped')
     AND ps.stage_version > 0
),
-- MATERIALIZED for the same reason as above (11.5 s for the reference
-- corpus's 37 decided events inlined without statistics, 6 ms materialized).
pairs AS MATERIALIZED (
  SELECT e.event_id AS source_id, e.user_id, p.from_raw, p.to_raw, p.relationship_type
    FROM decided d
    JOIN ci.events e ON e.event_id = d.id
    CROSS JOIN LATERAL (
      SELECT e.organizer_entity_id AS from_raw, e.event_id AS to_raw,
             'PARTICIPATED_IN'::text AS relationship_type
       WHERE e.organizer_entity_id IS NOT NULL
      UNION ALL
      SELECT unnest(e.participant_entity_ids), e.event_id, 'PARTICIPATED_IN'
      UNION ALL
      SELECT e.event_id, e.location_entity_id, 'LOCATED_AT'
       WHERE e.location_entity_id IS NOT NULL
    ) p
),
missing AS (
  SELECT DISTINCT p.source_id
    FROM pairs p
    JOIN ci.entities ef
      ON ef.entity_id = p.from_raw
     AND ef.owner_user_id = p.user_id
     AND (ef.is_active = TRUE OR ef.merged_into_entity_id IS NOT NULL)
    JOIN ci.entities et
      ON et.entity_id = p.to_raw
     AND et.owner_user_id = p.user_id
     AND (et.is_active = TRUE OR et.merged_into_entity_id IS NOT NULL)
   WHERE COALESCE(ef.merged_into_entity_id, ef.entity_id)
         <> COALESCE(et.merged_into_entity_id, et.entity_id)
     AND NOT EXISTS (
       SELECT 1
         FROM ci.relationships r
        WHERE r.from_entity_id = COALESCE(ef.merged_into_entity_id, ef.entity_id)
          AND r.to_entity_id = COALESCE(et.merged_into_entity_id, et.entity_id)
          AND r.relationship_type = p.relationship_type
          AND r.is_active = TRUE
     )
)
UPDATE ci.pipeline_state ps
   SET stage_version = 0,
       updated_at    = now()
  FROM missing m
 WHERE ps.entity_type = 'event'
   AND ps.stage = 'promote.edge_event'
   AND ps.entity_id = m.source_id
   AND ps.status IN ('done', 'skipped')
   AND ps.stage_version > 0;

-- ## Post-migration verification
--
-- The re-opened rows are candidates again (`stage_version` 0 < current), so
-- they drain on the next hourly sweep of each leg. After that, this should be 0:
--   SELECT count(*) FROM ci.pipeline_state
--    WHERE stage IN ('promote.edge_communication', 'promote.edge_event')
--      AND stage_version = 0 AND status IN ('done', 'skipped');

-- migrate:down

-- No-op, deliberately. This re-opened ledger rows whose `done` asserted edges
-- that do not exist. Putting the version back would re-assert that false claim
-- and hide the missing edges from the pipeline again. Once the legs have
-- re-projected, the rows are `done` at the current version anyway.
