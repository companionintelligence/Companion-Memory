-- migrate:up
-- Repair: withdraw the location estimates `enrich.estimate_location` v1 wrote
-- onto events that NAME their own location, together with the place links,
-- LOCATED_AT edges and place footprints that were built on top of them.
--
-- ## The bug
--
-- EstimateLocationStage v1 offered every live, non-predicted physical-presence
-- event to its temporal nearest-neighbour fill and declined only a row that
-- already had a REAL coordinate. An event whose own `location_name` had not
-- been geocoded (geocoding not configured, or not run yet) has no coordinate,
-- so it was given whatever the user's phone reported within 24 hours of it. A
-- calendar event "Flight to Taipei", location "Bangkok BKK", was
-- pinned to the user's home.
--
-- `promote.place` then did what its predicate says — a coordinate plus a
-- non-blank name is a place visit — and resolved (name, 0.001-degree cell)
-- through PlaceService.findOrCreateForGeocode, whose snap-cell dedupe handed
-- back whatever Location already sat in that cell: the home Location minted
-- from the user's own GPS fixes. `promote.edge_event` projected an
-- Event -LOCATED_AT-> Place edge from the link. KnownPlacesService clusters
-- located events by `location_entity_id` and labels a cluster with its most
-- common `location_name`, so Places -> Known places showed the home address as
-- "Taipei TPE · 12 events".
--
-- Fixed going forward in the same change: EstimateLocationStage v2 records such
-- a row as `skipped: has_location_name`, and LocationEstimateService's
-- candidate predicate (POST /api/maintenance/estimate-locations) excludes it.
-- Neither can repair what v1 already wrote:
--   1. The estimator owns the coordinate, not the link or the edge
--      (`promote.place` / `promote.edge_event` do). Withdrawing only the
--      coordinate would strand the link on a row `promote.place` can no longer
--      select, since its predicate needs a coordinate.
--   2. Those two stages hold `done` ledger rows for these events at their
--      current versions, and nothing re-offers a `done` row but a version
--      bump. Left alone, the day the event's own text DOES geocode, the right
--      place link would never be derived.
--
-- ## Measured on the reference corpus (2026-09-30, 198,747 events)
--
--   SELECT source_system, count(*) FROM ci.events
--    WHERE location_name IS NOT NULL AND btrim(location_name) <> ''
--      AND metadata->>'location_source' = 'estimated'
--    GROUP BY 1;
--   -- calendar | 37     (no other source system)
--
-- All 37 are ICS events at confidence 0.4 with `inference_sources.method =
-- temporal_nn`, linked by promote.place (metadata.promote.stage) to 24
-- Locations — 12 of them to the home Location, the 12 the Taipei card counted —
-- each with exactly one LOCATED_AT edge (rule event.happened_at) and one
-- unsummarized `created` graph delta. None carries an organizer, participants
-- or a parent event, so no other edge depends on them. 22 of the 24 Locations
-- are also linked from ci.position (real places); 2 ("Santa Ana SNA", "The
-- Grand, 520 4th Street…") exist only because promote.place minted them from
-- an estimated coordinate — see "Not touched".
--
-- The other 6 estimated events on that corpus (1 calendar, 5 amazon) carry no
-- name. Estimating those is the stage working as designed; they are untouched.
--
-- Dry run against a copy of that corpus, statements in order:
--   1. ci.graph_deltas     DELETE  37   (the edges' unsummarized `created` rows)
--                          INSERT   0   (`deleted` rows for summarized ones)
--   2. ci.relationships    DELETE  37
--   3. ci.events           UPDATE  37
--   4. ci.entities         UPDATE  24   (footprints promote.place derived from
--                                        those 37 events alone)
--   5. ci.pipeline_state   DELETE 111   (37 events x 3 stages)
--
-- ## What each event gets back
--
-- The inverse of what the estimator (and promote.place) wrote, as far as the
-- row still proves it:
--   location_coordinates  NULL. The estimator only ever filled a NULL
--                         coordinate or its own earlier estimate.
--   location_entity_id    NULL when promote.place wrote it — it was derived
--                         from the estimated coordinate. A link any other
--                         writer made is kept.
--   metadata              minus `location_source` (the estimator's key), and
--                         minus `promote` when that link is withdrawn.
--   is_inferred,          false and '{}' when inference_sources is still the
--   inference_sources     estimator's (method temporal_nn). The estimator
--                         replaced it wholesale, so it is the row's only
--                         recorded inference.
--   confidence_score      1.0 where it is exactly the estimator's 0.4. It wrote
--                         LEAST(existing, 0.4), so a lower value is the
--                         importer's own and is kept. 1.0 is the column default
--                         and what an event with no coordinate carries
--                         (TransformGoogleCalendar leaves it so); all 6,331
--                         unestimated events of the estimable source systems on
--                         the reference corpus carry exactly 1.0.
--
-- ## Footprints (statement 4)
--
-- promote.place derives `location_boundary` from the events currently linked to
-- a place and stamps `properties.promote`; it never writes over a boundary it
-- does not own. Once these links are gone, a Location left with no
-- promote.place-linked event has a footprint derived from nothing, which that
-- stage would never have written — and which `PlaceService.placesContaining`
-- would keep answering with (a point in West LA "inside" Santa Ana SNA). It is
-- cleared back to NULL, the only value an owned boundary can have replaced.
-- A Location that still has other promote.place-linked events is not cleared;
-- one of those events is re-armed below instead, so the stage recomputes the
-- hull from what is left. (None on the reference corpus.)
--
-- ## The ledger (statement 5)
--
-- Re-armed by DELETING ledger rows, as
-- 20260821024635_clear_ics_valarm_boilerplate_descriptions does, for exactly
-- three stages on the repaired events:
--   enrich.estimate_location  re-offered, and recorded under v2 as
--                             `skipped: has_location_name`.
--   promote.place             so the event is promoted afresh the day its own
--                             text geocodes. Until then it has no coordinate and
--                             fails the predicate, so nothing is re-linked now.
--   promote.edge_event        so that day's link gets its edge. The projection is
--                             INSERT … ON CONFLICT DO NOTHING and never withdraws
--                             an edge, which is why statement 2 deletes the old
--                             ones itself.
-- plus `promote.place` on one surviving linked event per Location that keeps
-- other links (see Footprints).
--
-- NOT re-armed: enrich.geocode — the estimate never affected it (that stage
-- overwrites `estimated` coordinates anyway), and re-arming would retry its
-- failures for no reason. index.vector_event / index.embed_event — event search
-- text is built from `location_name` (search-ingress/searchTexts.ts), which this
-- does not change, so no search row is stale and none is touched.
-- clean.temporal_repair is unrelated.
--
-- ## Not touched
--
-- The Location rows themselves. The 22 GPS-derived ones are correct; only the
-- event links to them were wrong. The 2 minted from an estimate are left in
-- place: deleting an entity means deleting its search rows, and the user may
-- have renamed or confirmed it since. After this migration they have no links
-- and no footprint. To list them on an appliance:
--   SELECT l.entity_id, l.name FROM ci.entities l
--    WHERE l.entity_type = 'Location' AND l.properties->>'source' = 'reverse_geocode'
--      AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.location_entity_id = l.entity_id)
--      AND NOT EXISTS (SELECT 1 FROM ci.position p WHERE p.location_entity_id = l.entity_id)
--      AND NOT EXISTS (SELECT 1 FROM ci.relationships r
--                       WHERE r.is_active AND l.entity_id IN (r.from_entity_id, r.to_entity_id));
--
-- STATEMENT ORDER MATTERS: everything is selected into the working set first,
-- because statement 3 removes the `location_source` key the selection reads and
-- the `location_entity_id` statements 2 and 4 follow.
--
-- Idempotent: after statement 3 no event carries `location_source =
-- 'estimated'` alongside a name, so a second run selects an empty working set
-- and every statement affects zero rows.

-- Guards a manual re-run inside a session that already ran this migration and
-- has not committed/disconnected (ON COMMIT DROP only clears it at commit).
DROP TABLE IF EXISTS _estimate_over_own_location;
DROP TABLE IF EXISTS _estimate_over_own_location_edges;
DROP TABLE IF EXISTS _estimate_over_own_location_places;

-- 0. The working set. `location_name` is tested exactly as GEOCODE_SOURCE and
--    EstimateLocationStage v2 test it. `promoted_location_id` is the link only
--    when promote.place owns it; `location_entity_id` from any other writer is
--    NULL here and survives statement 3.
CREATE TEMP TABLE _estimate_over_own_location ON COMMIT DROP AS
SELECT e.event_id,
       e.user_id,
       CASE WHEN e.metadata->'promote'->>'stage' = 'promote.place'
            THEN e.location_entity_id END AS promoted_location_id
  FROM ci.events e
 WHERE e.location_name IS NOT NULL
   AND btrim(e.location_name) <> ''
   AND e.metadata->>'location_source' = 'estimated';

-- The edges projected from those links: `event.happened_at` only, to the
-- Location — or its merge survivor, which is what the projection resolves an
-- endpoint to. The rule is part of the match on purpose: a receipt projects an
-- Event -LOCATED_AT-> Place edge too, and one that happens to share this pair
-- is justified by the receipt, not by the estimate.
CREATE TEMP TABLE _estimate_over_own_location_edges ON COMMIT DROP AS
SELECT r.relationship_id, r.relationship_type, r.from_entity_id, r.to_entity_id, r.owner_user_id
  FROM _estimate_over_own_location w
  JOIN ci.entities l ON l.entity_id = w.promoted_location_id
  JOIN ci.relationships r
    ON r.from_entity_id = w.event_id
   AND r.to_entity_id = COALESCE(l.merged_into_entity_id, l.entity_id)
 WHERE r.relationship_type = 'LOCATED_AT'
   AND r.properties->>'rule' = 'event.happened_at'
   AND r.is_active = true;

-- The Locations those links pointed at, and whether promote.place still links
-- any OTHER event to each. Decides statement 4's clear-or-recompute.
CREATE TEMP TABLE _estimate_over_own_location_places ON COMMIT DROP AS
SELECT p.location_id,
       (SELECT min(o.event_id::text)::uuid
          FROM ci.events o
         WHERE o.location_entity_id = p.location_id
           AND o.metadata->'promote'->>'stage' = 'promote.place'
           AND o.event_id NOT IN (SELECT event_id FROM _estimate_over_own_location)) AS surviving_event_id
  FROM (SELECT DISTINCT promoted_location_id AS location_id
          FROM _estimate_over_own_location
         WHERE promoted_location_id IS NOT NULL) p;

-- 1. The change trail for those edges. A `created` row nothing has summarized
--    yet describes an edge that should never have existed; it goes with the
--    edge, as 20260831002948_repair_google_voice_owner_me_person does. One a
--    summary already read cannot be un-read, so it gets a `deleted` row after
--    it instead of being contradicted in silence.
INSERT INTO ci.graph_deltas
       (node_type, change_type, relationship_id, relationship_type,
        from_entity_id, to_entity_id, owner_user_id, change_source, change_reason)
SELECT DISTINCT 'relationship', 'deleted', x.relationship_id, x.relationship_type,
       x.from_entity_id, x.to_entity_id, x.owner_user_id,
       'migration:20260930035044', 'estimate withdrawn from an event with its own location'
  FROM _estimate_over_own_location_edges x
  JOIN ci.graph_deltas d
    ON d.relationship_id = x.relationship_id
   AND d.change_type = 'created'
   AND d.summary_id IS NOT NULL;

DELETE FROM ci.graph_deltas d
 USING _estimate_over_own_location_edges x
 WHERE d.relationship_id = x.relationship_id
   AND d.change_type = 'created'
   AND d.summary_id IS NULL;

-- 2. The edges.
DELETE FROM ci.relationships r
 USING _estimate_over_own_location_edges x
 WHERE r.relationship_id = x.relationship_id;

-- 3. The events. See "What each event gets back".
UPDATE ci.events e
   SET location_coordinates = NULL,
       location_entity_id   = CASE WHEN w.promoted_location_id IS NOT NULL
                                   THEN NULL ELSE e.location_entity_id END,
       metadata             = CASE WHEN w.promoted_location_id IS NOT NULL
                                   THEN e.metadata - 'location_source' - 'promote'
                                   ELSE e.metadata - 'location_source' END,
       is_inferred          = CASE WHEN e.inference_sources->>'method' = 'temporal_nn'
                                   THEN false ELSE e.is_inferred END,
       inference_sources    = CASE WHEN e.inference_sources->>'method' = 'temporal_nn'
                                   THEN '{}'::jsonb ELSE e.inference_sources END,
       confidence_score     = CASE WHEN e.confidence_score = 0.4::float8
                                   THEN 1.0 ELSE e.confidence_score END,
       updated_at           = now()
  FROM _estimate_over_own_location w
 WHERE e.event_id = w.event_id;

-- 4. Footprints promote.place derived only from the links withdrawn above.
UPDATE ci.entities l
   SET location_boundary = NULL,
       properties        = l.properties - 'promote',
       updated_at        = now()
  FROM _estimate_over_own_location_places p
 WHERE l.entity_id = p.location_id
   AND p.surviving_event_id IS NULL
   AND l.properties->'promote'->>'stage' = 'promote.place';

-- 5. The ledger. See "The ledger".
DELETE FROM ci.pipeline_state ps
 USING _estimate_over_own_location w
 WHERE ps.entity_type = 'event'
   AND ps.entity_id = w.event_id
   AND ps.stage IN ('enrich.estimate_location', 'promote.place', 'promote.edge_event');

DELETE FROM ci.pipeline_state ps
 USING _estimate_over_own_location_places p
 WHERE ps.entity_type = 'event'
   AND ps.entity_id = p.surviving_event_id
   AND ps.stage = 'promote.place';

-- ## Post-migration verification
--
-- Should now be 0:
--   SELECT count(*) FROM ci.events
--    WHERE location_name IS NOT NULL AND btrim(location_name) <> ''
--      AND metadata->>'location_source' = 'estimated';
--
-- Should be 37 on the reference corpus, then move to `skipped /
-- has_location_name` as the estimator's sweep re-offers them:
--   SELECT ps.status, ps.reason, count(*)
--     FROM ci.events e
--     LEFT JOIN ci.pipeline_state ps
--       ON ps.entity_type = 'event' AND ps.entity_id = e.event_id
--      AND ps.stage = 'enrich.estimate_location'
--    WHERE e.source_system = 'calendar'
--      AND e.location_name IS NOT NULL AND btrim(e.location_name) <> ''
--      AND e.location_coordinates IS NULL
--    GROUP BY 1, 2;

-- migrate:down
-- No-op: irreversible data repair, same reasoning as
-- 20260821024635_clear_ics_valarm_boilerplate_descriptions. Writing the
-- estimates back would re-pin these events to places their own text says they
-- were not, and re-link them to Locations they never visited.
