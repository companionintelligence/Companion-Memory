-- migrate:up
-- Give a re-delivered event's PLACE the refresh its status, time and title got
-- (20261001145556, 20261001154235): a merge base, kept apart from what the row
-- shows.
--
-- WHY. A meeting whose place changes at its source kept its first-sync place for
-- good. Google re-delivers the change through its sync token, but
-- CalendarEventService.createOne finds the stored row by its identity and, since
-- #2890/#2898, refreshes only the status, the time and the title. The place was
-- left out on purpose: it is not one field but a cluster, with several writers
-- besides the source. `update` writes location_name, location_coordinates and
-- location_entity_id; enrich.geocode writes a point for a name the transform
-- could not place; enrich.event_reverse names a point; enrich.estimate_location
-- lends a neighbour's point to an event with no place of its own; promote.place
-- links the pair to a Location. A re-delivered place cannot simply overwrite
-- the row, and the name cannot be refreshed alone (moving the name while the
-- point stays on the old place is worse than leaving both stale; the argument is
-- in sourceLocationMerge.ts).
--
-- WHAT. One column, `source_location`: what the source delivered last time, as
-- one value {"name": text|null, "coordinates": [lng, lat]|null}. A re-delivery
-- is a three-way merge (sourceLocationMerge.ts): the new place lands only while
-- the row still shows the base, or shows what the pipeline derived from it, and
-- becomes the new base either way. NULL is "no base": the merge then reads the
-- base as "the source said nothing", so a row with no place follows its source
-- and a row with one stands. The object with both members null is "the source
-- delivered no place". It is one jsonb value rather than a column per half
-- because a name and a point can each be absent, and two columns cannot then say
-- whether a base exists at all. Nothing user-facing writes it: UpdateEventDto
-- has no field for it.
--
-- BACKFILL. Where the writer left evidence that the row still shows its source,
-- the base is what the source delivered, which is what the row shows except
-- where a pipeline stage wrote the value. A stage's value is derived, not the
-- source's, and is left out of the base:
--
--   metadata.location_source  location_name  location_coordinates  base
--   (none) / virtual          as stored      as stored             name, point
--   geocoded / approximate    as stored      NOT the source's      name, no point
--                                            (enrich.geocode placed
--                                            the name; the source sent
--                                            none that time)
--   estimated                 none           NOT the source's      no name, no point
--                                            (borrowed from a
--                                            neighbour)
--   reverse_geocoded          NOT the source's  as stored          no name, point
--                             (derived from the
--                             point)
--
-- That is exactly how the merge reads those tags on the row itself, so a
-- backfilled row and one the refresh wrote look the same to it.
--
-- Evidence that someone else edited the place: any `update` that changed a
-- detail field. Its graph delta does not say which field (`detail_updated` is
-- all it records), so unlike the time (`last_moved_at`, #2691) there is nothing
-- finer to go on, and a time edit made through `update` costs the base too. The
-- legacy GeocodeBatchListener writes its coordinates through `update`, so what it
-- geocoded is left without a base as well. Both fail on the side of "the row may
-- be a person's": the value stands until the source comes round to it, and the
-- merge records the base on the first delivery. `reschedule` records no delta, so
-- a drag does not cost the place its base.
--
-- Not backfilled, and for the reasons above never given a wrong base:
--   * a row whose tag says a stage wrote a value the stage could not have
--     written (an estimate on a row that has a name; a reverse-geocoded name on
--     a row with no point; a geocoded point on a row with no name);
--   * planned blocks and rows no source owns, as in the status/time/title
--     backfills.
ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS source_location jsonb;

COMMENT ON COLUMN ci.events.source_location IS
  'The place this row''s source last delivered, as {"name": text|null, '
  '"coordinates": [lng, lat]|null}: the merge base for the location refresh in '
  'CalendarEventService.createOne (sourceLocationMerge.ts). A re-delivered place '
  'lands only while the row still shows it, or shows what the pipeline derived '
  'from it. NULL when there is no base; both members null when the source '
  'delivered no place. Never user-writable.';

UPDATE ci.events e
   SET source_location = jsonb_build_object(
         'name',
         CASE WHEN btrim(COALESCE(e.location_name, '')) = ''
                OR e.metadata->>'location_source' = 'reverse_geocoded'
              THEN NULL
              ELSE e.location_name
         END,
         'coordinates',
         CASE WHEN e.location_coordinates IS NULL
                OR e.metadata->>'location_source' IN ('geocoded', 'approximate', 'estimated')
              THEN NULL
              ELSE jsonb_build_array(ST_X(e.location_coordinates::geometry),
                                     ST_Y(e.location_coordinates::geometry))
         END)
 WHERE e.source_location IS NULL
   AND e.source_id IS NOT NULL
   AND e.source_type IS DISTINCT FROM 'planning'
   -- A stage's value on a row it could not have written it for. The tag is
   -- COALESCEd: most rows have none, and `NOT (NULL AND …)` is NULL, which would
   -- drop every untagged row from the backfill.
   AND NOT (COALESCE(e.metadata->>'location_source', '') = 'estimated'
            AND btrim(COALESCE(e.location_name, '')) <> '')
   AND NOT (COALESCE(e.metadata->>'location_source', '') = 'reverse_geocoded'
            AND e.location_coordinates IS NULL)
   AND NOT (COALESCE(e.metadata->>'location_source', '') IN ('geocoded', 'approximate')
            AND btrim(COALESCE(e.location_name, '')) = '')
   AND NOT EXISTS (
         SELECT 1
           FROM ci.graph_deltas d
          WHERE d.entity_id = e.event_id
            AND d.change_type = 'updated'
            AND d.change_source IN ('EventService.update', 'CalendarEventService.update')
            AND d.changed_fields ? 'detail_updated');

-- migrate:down
ALTER TABLE ci.events DROP COLUMN IF EXISTS source_location;
