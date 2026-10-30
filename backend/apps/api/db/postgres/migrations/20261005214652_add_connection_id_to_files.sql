-- migrate:up

-- A pointer file (a cloud-drive file recorded by name, size and link, with no
-- bytes stored here) had nothing saying which connection wrote it, so
-- disconnecting Google Drive or Dropbox left every one of its pointer rows
-- behind. This is that link. Set only for pointer rows a connection's sync
-- creates; uploads, captures and imported files keep NULL and are untouched by
-- a disconnect.
--
-- Not an FK, for the same reason ci.content.connection_id is not: the
-- disconnect path deletes by this column itself, in its own order.
ALTER TABLE ci.files ADD COLUMN IF NOT EXISTS connection_id uuid;

-- The only read shape is the disconnect's "every file this connection wrote",
-- and almost every row is NULL.
CREATE INDEX IF NOT EXISTS files_connection_id_idx
    ON ci.files (connection_id) WHERE connection_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.files_connection_id_idx;
ALTER TABLE ci.files DROP COLUMN IF EXISTS connection_id;
