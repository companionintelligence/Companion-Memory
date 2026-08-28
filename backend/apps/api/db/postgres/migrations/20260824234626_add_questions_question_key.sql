-- migrate:up
-- A stable, database-independent name for a catalogue question.
--
-- WHY. `ci.questions.question_id` defaults to `gen_uuid_v7()`, so a seed
-- migration that inserts a row without naming an id mints a DIFFERENT uuid on
-- every appliance it runs on. Anything outside the database that wants to
-- point at one specific shipped question therefore has nothing durable to
-- point at. The Self page's "Life details" grid
-- (frontend/apps/web/src/pages/SelfPage/sections/lifeDetails.ts) learned this
-- the hard way: it hardcoded 29 uuids captured from the machine the feature
-- was built on, and on every other database those ids matched nothing — the
-- grid still rendered its questions (they are hardcoded too) while every
-- answer read and write resolved to no row and silently did nothing, so the
-- section looked permanently, inexplicably blank.
--
-- `question_key` is that durable name: a hand-picked slug, written by the
-- migration that seeds the question, referenced by client code instead of a
-- uuid. Nullable and unconstrained for the ~1.3k rows that nobody needs to
-- name — a key is for curated questions some surface depends on by name, not
-- a second id for everything.
--
-- SCOPE OF THE UNIQUENESS. Keyed on (question_key, is_private_to) rather than
-- question_key alone, because a shared question is copy-on-write: an ordinary
-- user's edit mints a private fork of the shared row and the origin is then
-- hidden from that one user (see 20260819051642_reflection_fork_on_shared_edit
-- and `excludeForkedOriginsSql`). The fork has to carry the same key or the
-- curated surface loses that question for exactly the user who cared enough to
-- edit it. So: one keyed shared row (is_private_to IS NULL) plus at most one
-- keyed row per user. NULLS NOT DISTINCT is what makes the shared row's NULL
-- owner collide with itself and stay unique.

ALTER TABLE ci.questions
  ADD COLUMN IF NOT EXISTS question_key TEXT;

COMMENT ON COLUMN ci.questions.question_key IS
  'Stable, database-independent slug for a curated question. Client code references this instead of question_id, which is minted fresh per appliance. NULL for the vast majority of catalogue rows.';

-- Keys are written by hand in migrations and typed by hand in client code, so
-- the format is pinned: a typo that differs only by case or a stray space
-- would otherwise become a silently unmatched key, which is the exact failure
-- this column exists to end.
ALTER TABLE ci.questions
  DROP CONSTRAINT IF EXISTS questions_question_key_format;

ALTER TABLE ci.questions
  ADD CONSTRAINT questions_question_key_format
  CHECK (question_key IS NULL OR question_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$');

CREATE UNIQUE INDEX IF NOT EXISTS questions_question_key_owner_uniq
  ON ci.questions (question_key, is_private_to)
  NULLS NOT DISTINCT
  WHERE question_key IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.questions_question_key_owner_uniq;

ALTER TABLE ci.questions
  DROP CONSTRAINT IF EXISTS questions_question_key_format;

ALTER TABLE ci.questions
  DROP COLUMN IF EXISTS question_key;
