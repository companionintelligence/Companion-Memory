-- migrate:up
-- Event ↔ file linkage (the durable association ci.events lacked). Mirrors
-- ci.message_files. A capture source uploads bytes once (deduped in ci.files by
-- hash) and references the resulting file id on its events as G1 `media[]`.
-- `role` distinguishes e.g. 'attachment' | 'photo_on_delivery' | 'media'.
CREATE TABLE IF NOT EXISTS ci.event_files (
  event_id   uuid        NOT NULL REFERENCES ci.events (event_id) ON DELETE CASCADE,
  file_id    uuid        NOT NULL REFERENCES ci.files (id)        ON DELETE CASCADE,
  role       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, file_id)
);
CREATE INDEX IF NOT EXISTS event_files_file_idx ON ci.event_files (file_id);

-- migrate:down
DROP TABLE IF EXISTS ci.event_files;
