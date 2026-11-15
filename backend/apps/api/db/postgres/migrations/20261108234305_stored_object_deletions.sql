-- migrate:up
-- Stored objects (bucket + key) whose ci.files rows have been deleted and whose bytes are
-- still to be deleted from the object store. A purge of content writes these rows in the
-- SAME transaction that deletes the file rows, and deletes the objects only after that
-- transaction commits. A rollback therefore takes the rows back with everything else and
-- leaves the bytes untouched, and a commit leaves a durable record of what to delete, so an
-- object-store failure, a timeout or a partial delete is retried by
-- StoredObjectDeletionSweepCron instead of being lost or of losing bytes. A row is deleted
-- once its object is confirmed gone. No user_id: the key names nothing the account owns
-- once its file row has gone, and the sweep re-checks that no ci.files row names it.
CREATE TABLE IF NOT EXISTS ci.stored_object_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL,
  object_key text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS idx_stored_object_deletions_queued
  ON ci.stored_object_deletions (queued_at);

-- migrate:down
DROP TABLE IF EXISTS ci.stored_object_deletions;
