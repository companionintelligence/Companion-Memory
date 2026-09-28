-- At most one live PLAYBACK rendition per video original.
--
-- VideoPlaybackService has two callers that do not coordinate: the upload
-- listener (worker process) and the enrich.video_playback sweep (api
-- process). Each checked for an existing rendition, then spooled, waited for
-- its encode slot and encoded for about the clip's length before inserting,
-- so a file both of them picked up got two x264 encodes and two PLAYBACK
-- rows. The service now re-checks right before the write, but only an index
-- makes the write itself exclusive across processes; a loser gets 23505,
-- which the service reads as "a rendition already exists".
--
-- Any duplicates an earlier build already wrote are soft-deleted first,
-- keeping the oldest (ids are UUIDv7, so the smallest id is the first
-- written). Soft, not hard: the rows still name their objects, and readers
-- (FileService.findVariant*) already skip deleted rows.
--
-- Built without CONCURRENTLY, matching 20260922180450: a partial index over
-- the handful of PLAYBACK rows, on a table of modest size.

-- migrate:up
UPDATE ci.files f
   SET deleted_at = now()
 WHERE f.variant = 'PLAYBACK'
   AND f.deleted_at IS NULL
   AND f.parent_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM ci.files older
                WHERE older.parent_id = f.parent_id
                  AND older.variant = 'PLAYBACK'
                  AND older.deleted_at IS NULL
                  AND older.id < f.id);

CREATE UNIQUE INDEX IF NOT EXISTS files_one_playback_per_parent_uniq
  ON ci.files (parent_id)
  WHERE variant = 'PLAYBACK' AND deleted_at IS NULL;

COMMENT ON INDEX ci.files_one_playback_per_parent_uniq IS
  'At most one live PLAYBACK rendition per original. VideoPlaybackService treats a 23505 on it as "a rendition already exists".';

-- migrate:down
DROP INDEX IF EXISTS ci.files_one_playback_per_parent_uniq;
