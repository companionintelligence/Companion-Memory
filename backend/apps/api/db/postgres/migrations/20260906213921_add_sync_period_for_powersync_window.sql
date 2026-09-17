-- migrate:up
-- Give ci.events and its CTI name rows a window marker PowerSync can filter on,
-- so CI-Capture's event lanes can reach a device without syncing all of history.
--
-- ## Why a plain column and not a generated one
--
-- PowerSync sync rules cannot express a rolling cutoff. A bucket parameter may
-- only appear in an equality, so `updated_at >= bucket.cutoff` is rejected
-- ("Cannot use bucket parameters in expressions"), and a client-supplied
-- parameter cannot filter a table-based parameter query either ("Cannot use
-- table values and parameters in the same clauses") -- client parameters are
-- untrusted, so PowerSync will not let them select rows. The window therefore
-- has to be decided server-side and expressed as something a data query can
-- test without parameters: `sync_period IS NOT NULL`.
--
-- It must also be a PLAIN column. The `powersync` publication reports
-- pubgencols='n', so PostgreSQL does not replicate GENERATED columns at all --
-- a generated marker would be invisible to the sync service, the same way
-- ci.events.duration_minutes is. The triggers below maintain it instead.
--
-- Eviction comes free: PowerSync removes a row from a client's bucket when it
-- stops matching the data query, so nulling sync_period is the whole retention
-- mechanism. Nothing is deleted -- the row stays on the server, it just leaves
-- the device.
--
-- The value is the 'YYYY-MM' period the row belongs to. Only IS NOT NULL is
-- load-bearing today; the period itself is carried so a device can group by
-- month, and so a later change can bucket on `sync_period = bucket.period`
-- (equality, which IS expressible) without another migration.

ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS sync_period text;
ALTER TABLE ci.entities ADD COLUMN IF NOT EXISTS sync_period text;

COMMENT ON COLUMN ci.events.sync_period IS
  'YYYY-MM window marker for PowerSync. NOT NULL means this row is inside the '
  'device sync window; the retention sweep nulls it to evict from devices. '
  'Maintained by trigger -- must stay a plain column, generated ones are not replicated.';
COMMENT ON COLUMN ci.entities.sync_period IS
  'As ci.events.sync_period, but set only for entity_type = ''Event'' -- the CTI '
  'rows carrying event name/description. NULL on every other entity type, which '
  'is what keeps people, places and things off devices.';

-- Partial indexes: every sync read is "the rows still in the window", and the
-- sweep below scans the same predicate. Partial keeps them small -- aged rows
-- drop out of the index when their marker is nulled.
CREATE INDEX IF NOT EXISTS events_sync_period_idx
  ON ci.events (user_id, sync_period) WHERE sync_period IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_sync_period_idx
  ON ci.entities (owner_user_id, sync_period) WHERE sync_period IS NOT NULL;

-- Stamp on write. observed_at is when the capture actually happened; it is NULL
-- for non-capture events, so fall back to start_time and then created_at.
CREATE OR REPLACE FUNCTION ci.set_event_sync_period() RETURNS trigger AS $$
BEGIN
  NEW.sync_period := to_char(
    COALESCE(NEW.observed_at, NEW.start_time, NEW.created_at, now()) AT TIME ZONE 'UTC',
    'YYYY-MM'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only Event-typed entities carry a marker. Anything else keeps NULL and so is
-- never selected by the sync rules, whatever else changes about this table.
CREATE OR REPLACE FUNCTION ci.set_entity_sync_period() RETURNS trigger AS $$
BEGIN
  IF NEW.entity_type = 'Event' THEN
    NEW.sync_period := to_char(
      COALESCE(NEW.created_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM'
    );
  ELSE
    NEW.sync_period := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE INSERT only, deliberately. On UPDATE the marker must stay whatever the
-- sweep last set it to: re-stamping here would resurrect an evicted row on any
-- unrelated edit, and an UPDATE trigger would also fight the sweep's own writes.
DROP TRIGGER IF EXISTS events_set_sync_period ON ci.events;
CREATE TRIGGER events_set_sync_period
  BEFORE INSERT ON ci.events
  FOR EACH ROW EXECUTE FUNCTION ci.set_event_sync_period();

DROP TRIGGER IF EXISTS entities_set_sync_period ON ci.entities;
CREATE TRIGGER entities_set_sync_period
  BEFORE INSERT ON ci.entities
  FOR EACH ROW EXECUTE FUNCTION ci.set_entity_sync_period();

-- Backfill only what is already inside the window. Older rows stay NULL, which
-- is the correct steady state -- they are exactly what the sweep would evict.
UPDATE ci.events
   SET sync_period = to_char(
         COALESCE(observed_at, start_time, created_at) AT TIME ZONE 'UTC', 'YYYY-MM')
 WHERE sync_period IS NULL
   AND COALESCE(observed_at, start_time, created_at) >= now() - interval '30 days';

UPDATE ci.entities
   SET sync_period = to_char(COALESCE(created_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM')
 WHERE sync_period IS NULL
   AND entity_type = 'Event'
   AND COALESCE(created_at, now()) >= now() - interval '30 days';

-- migrate:down
DROP TRIGGER IF EXISTS events_set_sync_period ON ci.events;
DROP TRIGGER IF EXISTS entities_set_sync_period ON ci.entities;
DROP FUNCTION IF EXISTS ci.set_event_sync_period();
DROP FUNCTION IF EXISTS ci.set_entity_sync_period();
DROP INDEX IF EXISTS ci.events_sync_period_idx;
DROP INDEX IF EXISTS ci.entities_sync_period_idx;
ALTER TABLE ci.events DROP COLUMN IF EXISTS sync_period;
ALTER TABLE ci.entities DROP COLUMN IF EXISTS sync_period;
