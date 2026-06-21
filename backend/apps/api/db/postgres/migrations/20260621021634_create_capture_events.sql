-- migrate:up
-- G1 unified-ingest raw capture log. Append-only durable record of every event a
-- capture source POSTs to /v1/events, idempotent on (user_id, source_system,
-- source_id). The materialized event (ci.events) is created from this row and
-- referenced via event_id. This is layer 1 of the event-ingest-spec.
CREATE TABLE IF NOT EXISTS ci.capture_events (
  capture_event_id uuid        PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
  user_id          uuid        NOT NULL REFERENCES ci.users (id),
  source_system    text        NOT NULL,
  source_id        text        NOT NULL,
  kind             text        NOT NULL,
  occurred_at      timestamptz NOT NULL,
  observed_at      timestamptz,
  payload          jsonb       NOT NULL DEFAULT '{}',
  event_id         uuid        REFERENCES ci.events (event_id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_system, source_id)
);
CREATE INDEX IF NOT EXISTS capture_events_kind_idx ON ci.capture_events (user_id, kind, occurred_at);

-- migrate:down
DROP TABLE IF EXISTS ci.capture_events;
