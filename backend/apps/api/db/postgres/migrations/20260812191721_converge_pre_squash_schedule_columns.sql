-- migrate:up
-- =================================================================
-- Converge columns the squash added but IF NOT EXISTS cannot backfill
-- =================================================================
-- 20260808150000 squashes three deleted migrations, and its CREATEs were made
-- IF NOT EXISTS so a database holding any subset of them could converge. That
-- fixes MISSING TABLES. It does nothing for DRIFTED COLUMNS: a table that
-- already exists is skipped whole, so a column the squashed definition added
-- relative to its predecessor is silently never created.
--
-- ci.event_candidates is the one table where that happened.
-- 20260803060153_schedule_candidates_and_rhythms.sql (deleted by bdb26fde8,
-- applied on any database migrated between Aug 3 and Aug 8) created it WITHOUT
-- `personalization`; the squashed definition has it. Those databases got a
-- table that satisfies IF NOT EXISTS and is missing a column EventCandidateEntity
-- selects on every read, so CandidateService.upsert fails with
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
