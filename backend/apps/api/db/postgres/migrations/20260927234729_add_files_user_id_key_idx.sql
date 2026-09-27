-- Serve FileService.assertOwnsKey's by-key ownership check without scanning the
-- caller's whole file library.
--
-- getFileContent/getFileStream now refuse a key unless the caller owns the
-- ci.files row, and do it with `SELECT id FROM ci.files WHERE key = $1 AND
-- user_id = $2 LIMIT 1` (withDeleted, so no deleted_at filter). Until now no
-- index covered `key`: the only candidate was files_user_id_idx (user_id), and
-- on a single-user appliance user_id is not selective, so each read walked
-- every file row the user owns. Every per-file background pass (preview
-- generation, MediaDimensionsStage, vision renditions, document parse, chat
-- attachments, portability export) runs under a real user context and pays
-- that check once per file, which made a full pass O(N^2) row visits.
--
-- (user_id, key) rather than (key) alone because the account import's
-- snapshotOwnedFileKeys (`SELECT key FROM ci.files WHERE user_id = $1 AND key
-- IS NOT NULL`) reads the same pair and can use it as an index-only scan.
-- Partial on key IS NOT NULL: a NULL key has no object to read, and `key = $1`
-- implies the predicate, so the ownership check still matches it.
--
-- Plain btree, cheap to maintain incrementally, so NOT in DEFERRABLE_INDEXES.
-- Not built CONCURRENTLY: dbmate wraps this migration in a transaction, the
-- same tradeoff 20260821164353_add_object_count_user_source_indexes.sql
-- documents. ci.files is tens of thousands of rows on a large real library, so
-- the blocking build is short.

-- migrate:up
CREATE INDEX IF NOT EXISTS files_user_id_key_idx
  ON ci.files (user_id, key)
  WHERE key IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.files_user_id_key_idx;
