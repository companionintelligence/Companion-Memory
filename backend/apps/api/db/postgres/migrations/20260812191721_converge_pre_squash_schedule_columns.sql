-- migrate:up
-- =================================================================
-- Converge a column the Aug 8 migration squash left behind
-- =================================================================
-- 20260808150000 consolidated three migrations that bdb26fde8 DELETED:
-- 20260709143129 (hbpe recurrence), 20260802053709 (tasks), 20260803060153
-- (schedule candidates + rhythms). Deleting them orphaned their rows in
-- schema_migrations — dbmate keys on the timestamp prefix, so a database that
-- applied any of the three still records a version this repo no longer
-- contains. Because the three landed at different times, such a database can
-- hold ANY SUBSET of the squashed content: one real case had
-- recurrence_profiles and rhythms but not tasks.
--
-- That subset problem is NOT what this migration fixes — a database in that
-- state cannot run 20260808150000 at all (its bare CREATE TABLE aborts on the
-- objects that already exist) and therefore never reaches this file. Repairing
-- one requires an out-of-band step; see the runbook referenced below. Committed
-- migrations are immutable here (.github/workflows/migration-integrity-check.yml
-- forbids in-place modification in every mode), so the repair cannot live in
-- 20260808150000 itself.
--
-- What this DOES fix is the databases that got through: those where every
-- squashed object already existed, so the migration's CREATEs were no-ops or it
-- was baselined by hand. Those carry a COLUMN-level drift, because the squashed
-- definition of ci.event_candidates gained a column its predecessor lacked.
-- 20260803060153_schedule_candidates_and_rhythms.sql (deleted by bdb26fde8,
-- applied on any database migrated between Aug 3 and Aug 8) created it WITHOUT
-- `personalization`; the squashed definition has it. Those databases end up with
-- a table that exists but is missing a column EventCandidateEntity selects on
-- every read, so CandidateService.upsert fails with
-- "column EventCandidateEntity.personalization does not exist" (42703) and the
-- schedule_sync smart-rotation job dies on every tick.
--
-- Verified against the other five tables in that squash
-- (hbpe.recurrence_profiles, hbpe.occurrence_log, ci.tasks,
-- ci.task_dependencies, ci.rhythms): the squash added no columns to any of
-- them, so this is the only drift to repair.
--
-- No-op on a fresh database, where 20260808150000 already created the column.

ALTER TABLE ci.event_candidates
    ADD COLUMN IF NOT EXISTS personalization JSONB;

COMMENT ON COLUMN ci.event_candidates.personalization IS
    'Cached how-you''d-do-it compose for this card, when the user has personalized it.';

-- migrate:down
-- Dropping this would re-break every pre-squash database and lose whatever the
-- personalization composer has cached. Converging forward is the only direction
-- that makes sense here.
SELECT 1;
