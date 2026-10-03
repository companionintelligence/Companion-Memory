-- migrate:up
-- Retire the second copy of 26 curated "Life details" questions.
--
-- WHY. On a freshly migrated database, 26 of the 29 questions the Self page's
-- Life details grid is built from exist TWICE as active shared rows:
--
--   * the catalogue row 20260818235602_reflections_functional_catalog.sql
--     inserted, under whatever id `ci.gen_uuid_v7()` minted on that install.
--     20260824234643_seed_life_details_question_keys.sql later adopted it and
--     gave it the `question_key` — ADOPT's tiebreak is `created_at ASC`, and
--     this row is the older of the two;
--   * the row 20260824232133_seed_life_details_stable_ids.sql inserted under
--     the uuid the Self page used to hardcode. Its header assumed those texts
--     had no row; on a fresh install they do, and its INSERT only guards on
--     `question_id` (ON CONFLICT DO NOTHING), so it made a second copy. That
--     copy never got a key.
--
-- On a fresh install the other three escape. Height already sat under its
-- pinned id (seeded by 20260730054500), and 20260824232133 deleted weight's
-- and orientation's wrong-id rows before inserting. An appliance that carried
-- its own legacy "How tall are you?" row can have a height twin as well:
-- 20260824083722 reactivated every inactive row with that text, and ADOPT
-- keyed the older one. Matching on text covers that case too.
--
-- Both copies are active, so the feed can ask a question twice, and 20 of the
-- 26 unkeyed copies are `traceable`, so QuestionService.findUnansweredByUserId
-- and SmartRotationListener infer each of those twice. The grid reads by key,
-- so an answer written to the unkeyed copy never shows up there.
--
-- WHAT AN EXISTING APPLIANCE LOOKS LIKE. The four PRs landed on main in
-- version order (#2084 on 2026-08-18, then #2284, #2323 and #2294 between
-- 2026-08-24 and 2026-08-25). So an appliance that tracked main has the fresh
-- install's shape: the catalogue row keyed, the pinned-id row not. Its answers,
-- feed items and forks can sit on EITHER copy. The Self page wrote to the
-- pinned id until #2294 and to the keyed row after it, and the Reflections
-- page, the feed and inference have always seen both. The one database the
-- pinned ids were copied from has a single row per text, so this is a no-op
-- there. Nothing below depends on WHICH copy is keyed: it matches on text.
--
-- WHAT THIS DOES. For each unkeyed active shared row (the "twin") whose text
-- matches a keyed active shared row (the "kept" row), in this order:
--
--   1. FORKS. A user who reworded or retired the twin holds a private fork of
--      it, which hides the twin but not the kept row, so they are still asked
--      the question. Their fork becomes a fork of the kept row, and takes its
--      key, exactly as QuestionService.forkSharedQuestion would have written
--      it. Skipped when that user already forked the kept row: one fork per
--      (origin, owner) is a database guarantee, and their two copies are
--      theirs to reconcile.
--   2. ANSWERS move, and none is deleted or rewritten; only `question_id`
--      changes. Each lands on the row that now stands for the question for
--      that user: their fork of the kept row if they have one, else the kept
--      row. A user whose fork step 1 re-pointed also has their answers on the
--      kept row adopted onto the fork. That is QuestionService.adoptOwnHistory,
--      which is what the app does when anyone forks. Where both copies were
--      answered, both answers survive and the most recent is current, the same
--      `answered_at DESC` rule the catalogue and the Self page already apply.
--   3. FEED ITEMS on the twin move to the kept row, unless that user already
--      has the kept row queued or now holds a fork of it. Those are dropped, as
--      is a re-pointed fork owner's item for the kept row: the front-of-feed
--      query does not apply excludeForkedOriginsSql, which is why
--      adoptOwnHistory removes it too. A dropped item would not have outlived
--      the twin anyway, because cleanupFeedQueue deletes items for inactive
--      questions before every enqueue.
--   4. CONTEXT PROMPTS that can still write (pending, answered, or failed and
--      due a retry) and were generated for the twin are re-pointed at the
--      same row its answers moved to. ContextPromptPersistService
--      .writeLinkedQa writes the answer to `source.id`, so otherwise the next
--      one answered would land on the retired row.
--   5. RETIRE the twin: `is_active = false`. Never DELETE. ci.answers and
--      ci.feed_queue both cascade from ci.questions.
--
-- Every change is recorded in ci.question_duplicate_retirements, one row per
-- row touched (a dropped feed item in full), so the down path can reverse
-- exactly what this did and nothing else. The ledger is also the audit trail
-- for "why is my answer on a different question id".
--
-- QUEUED INFERENCE JOBS. An `infer.question.answer` job already queued for a
-- twin when this runs is dropped when it starts: since #2891,
-- AnswerInferenceListener re-reads is_active, evidence_class and the owner's
-- forks before it calls the model (QuestionService.findInferenceStanding).
-- What is left is a job whose model call is already in flight, up to 60 s: it
-- can still write an inferred answer to the retired row, which the Self page
-- and the feed no longer read.
--
-- Idempotent: once a twin is retired it is no longer an active twin, so a
-- second run finds nothing to do, and the ledger's primary key absorbs a
-- repeat record.

CREATE TABLE IF NOT EXISTS ci.question_duplicate_retirements (
  change              TEXT NOT NULL CHECK (change IN (
                        'fork_repointed', 'answer_moved', 'feed_item_moved', 'feed_item_dropped',
                        'context_prompt_repointed', 'twin_retired')),
  -- The ci.questions / ci.answers / ci.feed_queue / ci.context_prompts row the
  -- change touched.
  row_id              UUID NOT NULL,
  retired_question_id UUID NOT NULL REFERENCES ci.questions (question_id) ON DELETE CASCADE,
  kept_question_id    UUID NOT NULL REFERENCES ci.questions (question_id) ON DELETE CASCADE,
  -- What the row pointed at before and after. NULL for 'twin_retired', and
  -- `to_question_id` is NULL for a dropped feed item.
  from_question_id    UUID,
  to_question_id      UUID,
  -- A dropped feed item, whole, so the down path can put it back.
  dropped_row         JSONB,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (change, row_id)
);

COMMENT ON TABLE ci.question_duplicate_retirements IS
  'Written by 20260930171432_retire_duplicate_life_details_questions: every answer, feed item, fork and '
  'context prompt it moved off a retired duplicate question, and the duplicates it retired. Read by that '
  'migration''s down path.';

-- The twins, and the kept row each is retired in favour of. DISTINCT ON is
-- belt and braces: two keyed shared rows cannot share a curated text today.
CREATE TEMP TABLE _twins ON COMMIT DROP AS
SELECT DISTINCT ON (t.question_id)
       t.question_id AS retired_id,
       k.question_id AS kept_id,
       k.question_key
  FROM ci.questions t
  JOIN ci.questions k
    ON lower(btrim(k.question_text)) = lower(btrim(t.question_text))
   AND k.question_id <> t.question_id
 WHERE t.is_private_to IS NULL AND t.question_key IS NULL AND t.is_active
   AND k.is_private_to IS NULL AND k.question_key IS NOT NULL AND k.is_active
 ORDER BY t.question_id, k.created_at, k.question_id;

-- 1. FORKS.
CREATE TEMP TABLE _repointed_forks (
  fork_id     UUID PRIMARY KEY,
  owner_id    UUID NOT NULL,
  retired_id  UUID NOT NULL,
  kept_id     UUID NOT NULL
) ON COMMIT DROP;

WITH repointed AS (
  UPDATE ci.questions f
     SET forked_from_question_id = t.kept_id,
         question_key            = t.question_key,
         updated_at              = now()
    FROM _twins t
   WHERE f.forked_from_question_id = t.retired_id
     AND f.question_key IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM ci.questions o
        WHERE o.is_private_to = f.is_private_to
          AND (o.forked_from_question_id = t.kept_id OR o.question_key = t.question_key)
     )
  RETURNING f.question_id, f.is_private_to, t.retired_id, t.kept_id
), recorded AS (
  INSERT INTO ci.question_duplicate_retirements
    (change, row_id, retired_question_id, kept_question_id, from_question_id, to_question_id)
  SELECT 'fork_repointed', question_id, retired_id, kept_id, retired_id, kept_id FROM repointed
  ON CONFLICT (change, row_id) DO NOTHING
)
INSERT INTO _repointed_forks (fork_id, owner_id, retired_id, kept_id)
SELECT question_id, is_private_to, retired_id, kept_id FROM repointed;

-- 2. ANSWERS. Planned before any moves, so every answer moves once, straight
-- to where it belongs.
CREATE TEMP TABLE _answer_moves ON COMMIT DROP AS
SELECT a.answer_id, t.retired_id, t.kept_id, a.question_id AS from_id,
       COALESCE(own.question_id, t.kept_id) AS to_id
  FROM ci.answers a
  JOIN _twins t ON a.question_id = t.retired_id
  LEFT JOIN ci.questions own
    ON own.forked_from_question_id = t.kept_id
   AND own.is_private_to = a.user_id
UNION ALL
SELECT a.answer_id, r.retired_id, r.kept_id, a.question_id, r.fork_id
  FROM ci.answers a
  JOIN _repointed_forks r ON a.question_id = r.kept_id AND a.user_id = r.owner_id;

WITH moved AS (
  UPDATE ci.answers a
     SET question_id = m.to_id
    FROM _answer_moves m
   WHERE a.answer_id = m.answer_id
  RETURNING m.answer_id, m.retired_id, m.kept_id, m.from_id, m.to_id
)
INSERT INTO ci.question_duplicate_retirements
  (change, row_id, retired_question_id, kept_question_id, from_question_id, to_question_id)
SELECT 'answer_moved', answer_id, retired_id, kept_id, from_id, to_id FROM moved
ON CONFLICT (change, row_id) DO NOTHING;

-- 3. FEED ITEMS.
CREATE TEMP TABLE _feed_plan ON COMMIT DROP AS
SELECT f.feed_queue_id, t.retired_id, t.kept_id, f.question_id AS from_id,
       CASE
         WHEN EXISTS (SELECT 1 FROM ci.questions own
                       WHERE own.forked_from_question_id = t.kept_id AND own.is_private_to = f.user_id)
           OR EXISTS (SELECT 1 FROM ci.feed_queue o
                       WHERE o.user_id = f.user_id AND o.question_id = t.kept_id)
         THEN 'drop'
         ELSE 'move'
       END AS action
  FROM ci.feed_queue f
  JOIN _twins t ON f.question_id = t.retired_id
UNION ALL
SELECT f.feed_queue_id, r.retired_id, r.kept_id, f.question_id, 'drop'
  FROM ci.feed_queue f
  JOIN _repointed_forks r ON f.question_id = r.kept_id AND f.user_id = r.owner_id;

WITH moved AS (
  UPDATE ci.feed_queue f
     SET question_id = p.kept_id
    FROM _feed_plan p
   WHERE f.feed_queue_id = p.feed_queue_id
     AND p.action = 'move'
  RETURNING f.feed_queue_id, p.retired_id, p.kept_id, p.from_id
)
INSERT INTO ci.question_duplicate_retirements
  (change, row_id, retired_question_id, kept_question_id, from_question_id, to_question_id)
SELECT 'feed_item_moved', feed_queue_id, retired_id, kept_id, from_id, kept_id FROM moved
ON CONFLICT (change, row_id) DO NOTHING;

WITH dropped AS (
  DELETE FROM ci.feed_queue f
   USING _feed_plan p
   WHERE f.feed_queue_id = p.feed_queue_id
     AND p.action = 'drop'
  RETURNING f.feed_queue_id, p.retired_id, p.kept_id, p.from_id, to_jsonb(f) AS dropped_row
)
INSERT INTO ci.question_duplicate_retirements
  (change, row_id, retired_question_id, kept_question_id, from_question_id, dropped_row)
SELECT 'feed_item_dropped', feed_queue_id, retired_id, kept_id, from_id, dropped_row FROM dropped
ON CONFLICT (change, row_id) DO NOTHING;

-- 4. CONTEXT PROMPTS. One pending prompt per user at most
-- (context_prompts_one_pending_per_user), so this is a handful of rows.
CREATE TEMP TABLE _prompt_moves ON COMMIT DROP AS
SELECT cp.context_prompt_id, t.retired_id, t.kept_id,
       COALESCE(own.question_id, t.kept_id) AS to_id
  FROM ci.context_prompts cp
  JOIN _twins t
    ON cp.source ->> 'kind' = 'question'
   AND cp.source ->> 'id' = t.retired_id::text
  LEFT JOIN ci.questions own
    ON own.forked_from_question_id = t.kept_id
   AND own.is_private_to = cp.user_id
 WHERE cp.status IN ('pending', 'answered', 'failed');

WITH moved AS (
  UPDATE ci.context_prompts cp
     SET source     = jsonb_set(cp.source, '{id}', to_jsonb(m.to_id::text)),
         updated_at = now()
    FROM _prompt_moves m
   WHERE cp.context_prompt_id = m.context_prompt_id
  RETURNING m.context_prompt_id, m.retired_id, m.kept_id, m.to_id
)
INSERT INTO ci.question_duplicate_retirements
  (change, row_id, retired_question_id, kept_question_id, from_question_id, to_question_id)
SELECT 'context_prompt_repointed', context_prompt_id, retired_id, kept_id, retired_id, to_id FROM moved
ON CONFLICT (change, row_id) DO NOTHING;

-- 5. RETIRE.
WITH retired AS (
  UPDATE ci.questions q
     SET is_active  = false,
         updated_at = now()
    FROM _twins t
   WHERE q.question_id = t.retired_id
  RETURNING t.retired_id, t.kept_id
)
INSERT INTO ci.question_duplicate_retirements (change, row_id, retired_question_id, kept_question_id)
SELECT 'twin_retired', retired_id, retired_id, kept_id FROM retired
ON CONFLICT (change, row_id) DO NOTHING;

-- 6. ASSERT.
--
-- Scoped to KEYED questions on purpose. "No two active shared rows share a
-- text" holds on a fresh install (lifeDetailsDuplicateRetirement.integration
-- .spec.ts proves it), but a real appliance can hold duplicates this migration
-- has no business deciding about: two answered legacy rows the catalogue
-- migration kept active, or rows a SYSTEM_USER caller of QuestionService.create
-- minted at runtime. Failing a deploy over those would be failing it for
-- someone else's data.
DO $$
DECLARE
  still_twinned TEXT[];
  left_behind   BIGINT;
BEGIN
  SELECT array_agg(DISTINCT k.question_key ORDER BY k.question_key)
    INTO still_twinned
    FROM ci.questions k
    JOIN ci.questions o
      ON lower(btrim(o.question_text)) = lower(btrim(k.question_text))
     AND o.question_id <> k.question_id
     AND o.is_private_to IS NULL
     AND o.is_active
   WHERE k.question_key IS NOT NULL
     AND k.is_private_to IS NULL
     AND k.is_active;

  IF still_twinned IS NOT NULL THEN
    RAISE EXCEPTION
      'Life details: % keyed question(s) still share their text with another active shared row: %',
      array_length(still_twinned, 1), array_to_string(still_twinned, ', ');
  END IF;

  SELECT (SELECT count(*) FROM ci.answers a JOIN _twins t ON a.question_id = t.retired_id)
       + (SELECT count(*) FROM ci.feed_queue f JOIN _twins t ON f.question_id = t.retired_id)
       + (SELECT count(*) FROM ci.context_prompts cp JOIN _twins t
                ON cp.source ->> 'kind' = 'question' AND cp.source ->> 'id' = t.retired_id::text
           WHERE cp.status IN ('pending', 'answered', 'failed'))
    INTO left_behind;

  IF left_behind > 0 THEN
    RAISE EXCEPTION
      'Life details: % answer(s), feed item(s) or open context prompt(s) still point at a question this migration retired',
      left_behind;
  END IF;
END $$;

-- migrate:down
-- Reverses exactly what the ledger says the up path did, then drops the
-- ledger. Each step only undoes a row that is still where the up path left
-- it: an answer the app has since moved again (a later fork adopts it) stays
-- where the app put it. A dropped feed item comes back only while its user
-- and question still exist and that user has not since had the question
-- queued again. Nothing is deleted.
--
-- Afterwards the twins are active again and every Life details question is
-- asked twice. That is the state this migration found, so it is the honest
-- thing to restore; 20260824232133's own down path is what removes the twins.

UPDATE ci.answers a
   SET question_id = l.from_question_id
  FROM ci.question_duplicate_retirements l
 WHERE l.change = 'answer_moved'
   AND a.answer_id = l.row_id
   AND a.question_id = l.to_question_id;

UPDATE ci.feed_queue f
   SET question_id = l.from_question_id
  FROM ci.question_duplicate_retirements l
 WHERE l.change = 'feed_item_moved'
   AND f.feed_queue_id = l.row_id
   AND f.question_id = l.to_question_id
   AND NOT EXISTS (
     SELECT 1 FROM ci.feed_queue o WHERE o.user_id = f.user_id AND o.question_id = l.from_question_id
   );

INSERT INTO ci.feed_queue (feed_queue_id, user_id, question_id, enqueued_at, item_type, metadata)
SELECT (l.dropped_row ->> 'feed_queue_id')::uuid,
       (l.dropped_row ->> 'user_id')::uuid,
       l.from_question_id,
       (l.dropped_row ->> 'enqueued_at')::timestamptz,
       l.dropped_row ->> 'item_type',
       COALESCE(l.dropped_row -> 'metadata', '{}'::jsonb)
  FROM ci.question_duplicate_retirements l
 WHERE l.change = 'feed_item_dropped'
   AND EXISTS (SELECT 1 FROM ci.users u WHERE u.id = (l.dropped_row ->> 'user_id')::uuid)
   AND EXISTS (SELECT 1 FROM ci.questions q WHERE q.question_id = l.from_question_id)
ON CONFLICT DO NOTHING;

UPDATE ci.context_prompts cp
   SET source     = jsonb_set(cp.source, '{id}', to_jsonb(l.from_question_id::text)),
       updated_at = now()
  FROM ci.question_duplicate_retirements l
 WHERE l.change = 'context_prompt_repointed'
   AND cp.context_prompt_id = l.row_id
   AND cp.source ->> 'id' = l.to_question_id::text;

UPDATE ci.questions f
   SET forked_from_question_id = l.from_question_id,
       question_key            = NULL,
       updated_at              = now()
  FROM ci.question_duplicate_retirements l
 WHERE l.change = 'fork_repointed'
   AND f.question_id = l.row_id
   AND f.forked_from_question_id = l.to_question_id
   AND NOT EXISTS (
     SELECT 1 FROM ci.questions o
      WHERE o.is_private_to = f.is_private_to AND o.forked_from_question_id = l.from_question_id
   );

UPDATE ci.questions q
   SET is_active  = true,
       updated_at = now()
  FROM ci.question_duplicate_retirements l
 WHERE l.change = 'twin_retired'
   AND q.question_id = l.row_id
   AND NOT q.is_active;

DROP TABLE IF EXISTS ci.question_duplicate_retirements;
