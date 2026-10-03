-- migrate:up
-- Repair: withdraw the place links `promote.place` wrote onto events that did
-- not happen, together with the LOCATED_AT edges and place footprints built on
-- them.
--
-- ## The bug
--
-- PROMOTE_PLACE_SOURCE applied to any event with a coordinate, a non-blank
-- `location_name` and `is_deleted = false`. It never asked whether the event
-- happened. Google Calendar sync keeps a meeting cancelled at the source as a
-- row, venue and all; `enrich.geocode` resolves the venue like any other; and
-- promote.place then linked the meeting to a Location. The same went for a
-- no_show or skipped event, a prediction, and a Google Takeout reservation
-- cancelled only through `metadata.Canceled` (its status stays 'confirmed').
-- Each such link:
--   - counted the event as a visit (`PlaceService.getVisitStats` counts every
--     linked event);
--   - put its coordinate in the Location's footprint (`location_boundary`, the
--     hull of the events linked to it);
--   - let `promote.edge_event` project Event -LOCATED_AT-> Place with rule
--     `event.happened_at`, for an event that did not happen.
--
-- Fixed going forward in the same change: PROMOTE_PLACE_SOURCE now requires
-- `eventHappenedSql('s')`, the rule enrich.estimate_location applies (#2887),
-- and a row called off between the sweep and its slice is recorded as
-- `skipped: event_did_not_happen`. Neither can repair what is already written:
--   1. The predicate gates every arm of the sweep, the version arm included,
--      so these rows are never offered again, and no version bump can reach
--      them. So PLACE_PROMOTION_RULE_GENERATION was not bumped.
--   2. promote.place never withdraws a link anyway, edge projection is
--      INSERT … ON CONFLICT DO NOTHING and never withdraws an edge, and a
--      footprint is only recomputed for a Location some later slice links an
--      event to.
--
-- ## The working set
--
-- Every link promote.place owns (metadata.promote.stage = 'promote.place') on
-- an event that the NEW clauses refuse: a prediction, a status of cancelled,
-- no_show or skipped, or `Canceled: true`. That is NOT (eventHappenedSql('e'))
-- without its `is_deleted` clause, written out below exactly as the stage
-- builds it; PlaceLinkDidNotHappenRepair.integration.spec.ts pins the text.
-- It includes such an event that has since been deleted as well: restoring it
-- gives back an event that did not happen, which must not be linked.
--
-- An event refused ONLY because it is deleted is left alone. The predicate
-- refused deleted events before this change too, so its link was written while
-- it was live, and a tombstone keeps its edges so that restoring it is exact
-- (20261001061105_converge_event_liveness_flags, #2873).
--
-- A link any other writer made (GeocodeBatchListener, an importer) is not
-- promote.place's and is left alone, with whatever edge was projected from it.
--
-- ## Measured on the reference corpus (2026-10-01, 198,747 events)
--
-- Every event is `confirmed`; none is deleted or predicted; 5 Takeout
-- reservations carry `Canceled: true`, all without a coordinate. So 0 events
-- that did not happen are located, 0 are linked by any writer, 0 have an
-- `event.happened_at` edge, and promote.place has 0 ledger rows on them (its
-- 57 links are all on events that happened). This migration changes nothing
-- there. It is for appliances with calendar sync, where a meeting cancelled at
-- the source keeps its venue. To count it on one before upgrading:
--
--   SELECT count(*) AS links,
--          count(DISTINCT location_entity_id) AS locations
--     FROM ci.events
--    WHERE metadata->'promote'->>'stage' = 'promote.place'
--      AND location_entity_id IS NOT NULL
--      AND (COALESCE(is_predicted, false)
--           OR COALESCE(status, 'confirmed') IN ('cancelled', 'no_show', 'skipped')
--           OR COALESCE(metadata->>'Canceled', '') = 'true');
--
-- ## What each event gets back
--
--   location_entity_id    NULL. It was promote.place's, by the provenance
--                         marker, and that stage would not write it now.
--   metadata              minus `promote`, the marker that link carried.
--   location_coordinates  KEPT, with `location_name`. They are inputs from
--                         importers and enrich.geocode, and still right about
--                         the venue; they are not evidence the user went.
--
-- ## The edges (statements 1 and 2)
--
-- `event.happened_at` LOCATED_AT edges from those events to the Location, or
-- to its merge survivor, which is what the projection resolves an endpoint to
-- (one hop). The rule is part of the match: a receipt projects
-- Event -LOCATED_AT-> Place too (`receipt.happened_at`), and an edge it
-- projected over the same pair is the receipt's, not the link's. Their change
-- trail is handled as in 20260930035044: an unsummarized `created` delta goes
-- with its edge; one a summary already read gets a `deleted` row after it.
--
-- ## Footprints (statement 4)
--
-- promote.place derives `location_boundary` from the events linked to a place
-- and stamps `properties.promote`. A Location that promote.place still links
-- an event to, and whose sweep will offer that event, keeps its footprint; one
-- such event is re-armed (statement 5), so the stage recomputes the hull from
-- the links that are left. Any other Location the working set pointed at has
-- its footprint cleared back to NULL, the only value an owned boundary can
-- have replaced: what is left of it was derived from links that are gone, and
-- `PlaceService.placesContaining` would go on answering with it. A boundary
-- without promote.place's provenance (drawn by a person, or supplied by an
-- importer) is never touched.
--
-- ## The ledger (statement 5)
--
-- Re-armed by DELETING ledger rows, as 20260930035044 does:
--   promote.place on every repaired event. Its row says `done` at the current
--                 version, so without this a reinstated event (status set
--                 back to confirmed) would never be offered again, and would
--                 stay unlinked. While it did not happen, the predicate keeps
--                 it out, so nothing is re-linked now.
--   promote.place on the one surviving event per Location (see Footprints).
-- NOT re-armed: promote.edge_event. Its projection cannot re-create an edge
-- from a link that is gone, and when a reinstated event is linked again,
-- STAGE_REOPENS (reopens.ts) re-opens it from promote.place's `done`. Nothing
-- else reads the link: event search text is built from `location_name`, which
-- this does not change.
--
-- ## Not touched
--
-- The Location rows. A Location minted only from events that did not happen
-- (the venue of a meeting that was called off) stays, with no links and no
-- footprint: deleting an entity means deleting its search rows, and the user
-- may have renamed or confirmed it since. To list them:
--   SELECT l.entity_id, l.name FROM ci.entities l
--    WHERE l.entity_type = 'Location' AND l.is_active
--      AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.location_entity_id = l.entity_id)
--      AND NOT EXISTS (SELECT 1 FROM ci.position p WHERE p.location_entity_id = l.entity_id)
--      AND NOT EXISTS (SELECT 1 FROM ci.relationships r
--                       WHERE r.is_active AND l.entity_id IN (r.from_entity_id, r.to_entity_id));
--
-- Links written AFTER this runs, onto an event that is cancelled later, are
-- not repaired by anything: the sweep stops offering the row, as above. That
-- is the cost of making the rule applicability rather than a recorded skip;
-- see PROMOTE_PLACE_SOURCE.
--
-- STATEMENT ORDER MATTERS: the working set is selected first, because
-- statement 3 removes the `promote` marker the selection reads and the
-- `location_entity_id` that statements 1, 2 and 4 follow.
--
-- Idempotent: after statement 3 no event in the working set carries
-- promote.place's marker, so a second run selects nothing and every statement
-- affects zero rows.

-- Guards a manual re-run inside a session that already ran this migration and
-- has not committed/disconnected (ON COMMIT DROP only clears it at commit).
DROP TABLE IF EXISTS _place_links_did_not_happen;
DROP TABLE IF EXISTS _place_links_did_not_happen_edges;
DROP TABLE IF EXISTS _place_links_did_not_happen_places;

-- 0. The working set. See "The working set".
CREATE TEMP TABLE _place_links_did_not_happen ON COMMIT DROP AS
SELECT e.event_id,
       e.user_id,
       e.location_entity_id AS promoted_location_id
  FROM ci.events e
 WHERE e.metadata->'promote'->>'stage' = 'promote.place'
   AND e.location_entity_id IS NOT NULL
   AND NOT (COALESCE(e.is_predicted, false) = false AND COALESCE(e.status, 'confirmed') NOT IN ('cancelled', 'no_show', 'skipped') AND COALESCE(e.metadata->>'Canceled', '') <> 'true');

-- The edges projected from those links. See "The edges".
CREATE TEMP TABLE _place_links_did_not_happen_edges ON COMMIT DROP AS
SELECT r.relationship_id, r.relationship_type, r.from_entity_id, r.to_entity_id, r.owner_user_id
  FROM _place_links_did_not_happen w
  JOIN ci.entities l ON l.entity_id = w.promoted_location_id
  JOIN ci.relationships r
    ON r.from_entity_id = w.event_id
   AND r.to_entity_id = COALESCE(l.merged_into_entity_id, l.entity_id)
 WHERE r.relationship_type = 'LOCATED_AT'
   AND r.properties->>'rule' = 'event.happened_at'
   AND r.is_active = true;

-- The Locations those links pointed at, and for each one an event promote.place
-- still links to it that its sweep will offer: located, named and happened
-- (PROMOTE_PLACE_SOURCE's predicate, on alias `o`). No event in the working set
-- can pass that, so none is ever its own Location's survivor.
-- Decides statement 4's clear-or-recompute.
CREATE TEMP TABLE _place_links_did_not_happen_places ON COMMIT DROP AS
SELECT p.location_id,
       (SELECT min(o.event_id::text)::uuid
          FROM ci.events o
         WHERE o.location_entity_id = p.location_id
           AND o.metadata->'promote'->>'stage' = 'promote.place'
           AND o.location_coordinates IS NOT NULL
           AND o.location_name IS NOT NULL
           AND btrim(o.location_name) <> ''
           AND COALESCE(o.is_deleted, false) = false
           AND COALESCE(o.is_predicted, false) = false
           AND COALESCE(o.status, 'confirmed') NOT IN ('cancelled', 'no_show', 'skipped')
           AND COALESCE(o.metadata->>'Canceled', '') <> 'true') AS surviving_event_id
  FROM (SELECT DISTINCT promoted_location_id AS location_id
          FROM _place_links_did_not_happen) p;

-- 1. The change trail for those edges. A `created` row nothing has summarized
--    yet describes an edge that should never have existed; it goes with the
--    edge. One a summary already read cannot be un-read, so it gets a
--    `deleted` row after it instead of being contradicted in silence.
INSERT INTO ci.graph_deltas
       (node_type, change_type, relationship_id, relationship_type,
        from_entity_id, to_entity_id, owner_user_id, change_source, change_reason)
SELECT DISTINCT 'relationship', 'deleted', x.relationship_id, x.relationship_type,
       x.from_entity_id, x.to_entity_id, x.owner_user_id,
       'migration:20261001153044', 'place link withdrawn from an event that did not happen'
  FROM _place_links_did_not_happen_edges x
  JOIN ci.graph_deltas d
    ON d.relationship_id = x.relationship_id
   AND d.change_type = 'created'
   AND d.summary_id IS NOT NULL;

DELETE FROM ci.graph_deltas d
 USING _place_links_did_not_happen_edges x
 WHERE d.relationship_id = x.relationship_id
   AND d.change_type = 'created'
   AND d.summary_id IS NULL;

-- 2. The edges.
DELETE FROM ci.relationships r
 USING _place_links_did_not_happen_edges x
 WHERE r.relationship_id = x.relationship_id;

-- 3. The events. See "What each event gets back".
UPDATE ci.events e
   SET location_entity_id = NULL,
       metadata           = e.metadata - 'promote',
       updated_at         = now()
  FROM _place_links_did_not_happen w
 WHERE e.event_id = w.event_id;

-- 4. Footprints promote.place derived, where no event it will be offered is
--    left to re-derive them from.
UPDATE ci.entities l
   SET location_boundary = NULL,
       properties        = l.properties - 'promote',
       updated_at        = now()
  FROM _place_links_did_not_happen_places p
 WHERE l.entity_id = p.location_id
   AND p.surviving_event_id IS NULL
   AND l.properties->'promote'->>'stage' = 'promote.place';

-- 5. The ledger. See "The ledger".
DELETE FROM ci.pipeline_state ps
 USING _place_links_did_not_happen w
 WHERE ps.entity_type = 'event'
   AND ps.entity_id = w.event_id
   AND ps.stage = 'promote.place';

DELETE FROM ci.pipeline_state ps
 USING _place_links_did_not_happen_places p
 WHERE ps.entity_type = 'event'
   AND ps.entity_id = p.surviving_event_id
   AND ps.stage = 'promote.place';

-- ## Post-migration verification
--
-- The count query under "Measured on the reference corpus" should now return 0
-- links. It stays 0 while the stage runs, unless an event promote.place has
-- linked is cancelled afterwards (see "Not touched").

-- migrate:down
-- No-op: irreversible data repair, same reasoning as
-- 20260930035044_clear_estimates_on_events_with_own_location. Writing the
-- links back would count events that did not happen as visits again.
