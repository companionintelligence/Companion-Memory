-- migrate:up
-- Companion applet device pairing. The applet (unauthenticated) starts a
-- pairing (PENDING) and polls with a secret poll_key; a signed-in user approves
-- it, which mints a long-lived applet_access_token and assigns a device_id.
CREATE TABLE IF NOT EXISTS ci.applet_pairing (
  id                  uuid        PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
  pairing_token       text        NOT NULL UNIQUE,
  poll_key            text        NOT NULL,
  status              text        NOT NULL DEFAULT 'PENDING',
  user_id             uuid        REFERENCES ci.users (id) ON DELETE CASCADE,
  user_name           text,
  user_email          text,
  device_id           uuid,
  applet_access_token text,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Activity-perception snapshots streamed by paired applets (the vizier engine's
-- wake/snapshot/watch output). payload keeps the full observation; the promoted
-- columns make the common signals queryable.
CREATE TABLE IF NOT EXISTS ci.user_snapshots (
  id             uuid        PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
  user_id        uuid        NOT NULL REFERENCES ci.users (id) ON DELETE CASCADE,
  device_id      uuid        NOT NULL,
  session_id     text        NOT NULL,
  snapshot_kind  text        NOT NULL,
  observed_at    timestamptz NOT NULL,
  monotonic_ms   bigint      NOT NULL,
  payload        jsonb       NOT NULL DEFAULT '{}',
  focus_app      text,
  focus_title    text,
  cwd            text,
  fs_event_count integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_snapshots_user_observed_idx ON ci.user_snapshots (user_id, observed_at);

-- migrate:down
DROP TABLE IF EXISTS ci.user_snapshots;
DROP TABLE IF EXISTS ci.applet_pairing;
