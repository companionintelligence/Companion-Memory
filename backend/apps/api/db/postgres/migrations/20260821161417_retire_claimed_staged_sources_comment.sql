-- staged_sources.run_id: name the janitor that actually exists.
--
-- The comment created with this column promised one: "A claimed row whose run
-- was deleted has no janitor; the uploads-dir orphan sweep is the backstop."
-- The orphan sweep could never have been that. It reclaims BYTES the uploads
-- directory holds and NO row accounts for, and `StagedSourceService.
-- dropDirIsLive` reads `claimed` as live — so the one row the comment was about
-- was the one row that sweep is guaranteed to skip. `purgeExpired` only ever
-- read `status = 'staged'`. A claimed upload whose run was deleted therefore
-- kept both its bytes and its row forever, while being invisible in the uploads
-- list, undeletable by its owner, and re-importable by nobody: `startRun`
-- answers "already claimed by another import run" about a run that no longer
-- exists.
--
-- Nothing deleted an import run when this column was written, so the claim was
-- never exercised. The retention sweep and the run discard both delete runs
-- now, which is what made it load-bearing.
--
-- So the promise is kept rather than dropped, in two places, and this comment
-- names both. There is no data repair here on purpose: no released code path
-- has ever deleted an import_runs row, so no orphan can predate this, and the
-- hourly purge re-stages one within the hour if one ever appears.

-- migrate:up
COMMENT ON COLUMN ci_import.staged_sources.run_id IS
  'The run consuming this source, or NULL. ON DELETE SET NULL — deleting a run must not orphan staged bytes by taking their registry row with it. Retirement settles the rows instead of orphaning them (ImportRetentionService.retireRun, in the same transaction as the run delete): a claimed UPLOAD is re-staged, back on the uploads list and back under the TTL purge, and a claimed INBOX row is deleted so its path is claimable again. StagedSourceService.purgeExpired re-stages any claimed upload that lost its run some other way, which is the backstop under this constraint.';

-- migrate:down
COMMENT ON COLUMN ci_import.staged_sources.run_id IS
  'The run consuming this source, or NULL. ON DELETE SET NULL — deleting a run must not orphan staged bytes by taking their registry row with it. A claimed row whose run was deleted has no janitor; the uploads-dir orphan sweep is the backstop.';
