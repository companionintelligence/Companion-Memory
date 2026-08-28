-- migrate:up
-- Three gaps left by 20260818235602_reflections_functional_catalog.sql, found
-- while building the Self page's "Life details" section (Health & Body /
-- Identity & Background themes):
--
-- 1. The existing weight question ('Do you know your current weight?') is
--    phrased as yes/no rather than eliciting a number. Deactivate it (only if
--    nobody has answered it, same rule that migration's own step 3 uses) and
--    add a cleanly-phrased replacement.
-- 2. Orientation had a question in the old ad-hoc catalogue
--    ('How does your sexual orientation influence your identity and
--    experiences?'), but it was an unanswered `created_by_llm` row and so was
--    auto-retired by that migration's step 3 along with the rest of the
--    709-row essay catalogue. Add a concrete, answerable replacement.
-- 3. Height has no active question at all, and it is not simply missing: an
--    old `created_by_llm` row with the exact text 'How tall are you?' already
--    existed (retired by that migration's own step 3, same as orientation),
--    and that migration's own step 5 seed insert for the identical phrase
--    ('How tall are you?', Health & Body, factual, tags height/body) was
--    silently skipped by its `NOT EXISTS (... question_text ...)` guard,
--    which matches on text regardless of is_active — so the clean seed
--    version was never actually added, and the row was left inactive with
--    `answer_tier` still null. Repair in place rather than inserting a
--    duplicate: reactivate it and backfill the exact seed-row shape that
--    migration intended.
--
-- Idempotent: the inserts are guarded by NOT EXISTS on question_text, and
-- both the weight deactivation and the height repair only touch a row that is
-- still unanswered and un-queued (i.e. a no-op once someone has answered it).

UPDATE ci.questions q
   SET is_active  = false,
       updated_at = now()
 WHERE q.is_active
   AND lower(btrim(q.question_text)) = lower(btrim('Do you know your current weight?'))
   AND NOT EXISTS (SELECT 1 FROM ci.answers a WHERE a.question_id = q.question_id)
   AND NOT EXISTS (SELECT 1 FROM ci.feed_queue f WHERE f.question_id = q.question_id);

UPDATE ci.questions q
   SET is_active         = true,
       is_seed_question  = true,
       created_by_llm    = false,
       question_category = 'Health & Body',
       question_type     = 'open_ended',
       frequency_recommendation = 'annually',
       context_tags      = ARRAY['height','body']::text[],
       answer_tier       = 'factual',
       updated_at        = now()
 WHERE NOT q.is_active
   AND lower(btrim(q.question_text)) = lower(btrim('How tall are you?'))
   AND NOT EXISTS (SELECT 1 FROM ci.answers a WHERE a.question_id = q.question_id)
   AND NOT EXISTS (SELECT 1 FROM ci.feed_queue f WHERE f.question_id = q.question_id);

INSERT INTO ci.questions
  (question_text, question_category, question_type, frequency_recommendation,
   context_tags, answer_tier, is_seed_question, created_by_llm, is_active)
SELECT v.question_text, v.question_category, v.question_type, v.frequency_recommendation,
       v.context_tags, v.answer_tier, true, false, true
  FROM (VALUES
    ('What is your current weight?', 'Health & Body', 'open_ended', 'monthly', ARRAY['weight','body']::text[], 'factual'),
    ('How would you describe your sexual orientation?', 'Identity & Background', 'open_ended', 'one_time', ARRAY['orientation','identity']::text[], 'preference')
  ) AS v(question_text, question_category, question_type, frequency_recommendation,
         context_tags, answer_tier)
 WHERE NOT EXISTS (
   SELECT 1 FROM ci.questions e
    WHERE lower(btrim(e.question_text)) = lower(btrim(v.question_text))
 );

-- migrate:down
-- Remove only what this migration inserted, and only if it is still
-- untouched — a seed question somebody has since answered is left alone. The
-- weight deactivation is not reversed: nothing here records whether it was
-- already inactive before this migration ran. The height repair IS reversed
-- (it edited a pre-existing row rather than inserting one), back to the exact
-- state 20260818235602 left it in — inactive, null tier, not a seed row.
DELETE FROM ci.questions q
 WHERE q.is_seed_question
   AND NOT q.created_by_llm
   AND lower(btrim(q.question_text)) IN (
     lower(btrim('What is your current weight?')),
     lower(btrim('How would you describe your sexual orientation?'))
   )
   AND NOT EXISTS (SELECT 1 FROM ci.answers a WHERE a.question_id = q.question_id)
   AND NOT EXISTS (SELECT 1 FROM ci.feed_queue f WHERE f.question_id = q.question_id);

UPDATE ci.questions q
   SET is_active        = false,
       is_seed_question = false,
       created_by_llm   = true,
       answer_tier      = NULL,
       updated_at       = now()
 WHERE q.is_seed_question
   AND NOT q.created_by_llm
   AND lower(btrim(q.question_text)) = lower(btrim('How tall are you?'))
   AND NOT EXISTS (SELECT 1 FROM ci.answers a WHERE a.question_id = q.question_id)
   AND NOT EXISTS (SELECT 1 FROM ci.feed_queue f WHERE f.question_id = q.question_id);
