-- migrate:up
-- Name the 29 questions the Self page's "Life details" grid is built from, so
-- that grid can reference them by key instead of by uuid.
--
-- This list is the database half of a contract whose other half is
-- frontend/apps/web/src/pages/SelfPage/sections/lifeDetails.ts. The two are
-- kept in step by lifeDetails.catalogue.node.test.ts, which parses the CTE
-- below and fails if the file names a key this migration does not seed, or
-- disagrees with it about a question's text, category, type or tier. Adding a
-- curated question means adding it in BOTH places, in the same change.
--
-- Three things happen here, in order:
--
--   1. ADOPT. On a database where these questions already exist — under
--      whatever random uuid `gen_uuid_v7()` handed them, from
--      20260818235602_reflections_functional_catalog.sql or
--      20260824083722_seed_life_details_questions.sql — the shared row with
--      the matching text takes the key, and is normalised to the shape the
--      curated list declares. Reactivating is deliberate: a curated question
--      that is inactive does not come back from the grid's `status=active`
--      fetch, which is the same blank section by another route.
--   2. SEED. Anything still missing is inserted, key included.
--   3. FORKS. A user who edited one of these before keys existed holds a
--      private copy, and the shared original is hidden from them
--      (`excludeForkedOriginsSql`). The copy inherits the key, or that user is
--      the one person who loses the question. One fork per (origin, owner) is
--      already a database guarantee, so this cannot collide.
--
-- Idempotent throughout: every step is a no-op once it has run.

CREATE TEMP TABLE _curated_life_details (
  question_key TEXT,
  question_text TEXT,
  question_category TEXT,
  question_type TEXT,
  answer_tier TEXT,
  frequency_recommendation TEXT,
  context_tags TEXT[]
) ON COMMIT DROP;

INSERT INTO _curated_life_details
  (question_key, question_text, question_category, question_type, answer_tier, frequency_recommendation, context_tags)
VALUES
  ('blood_type', 'What is your blood type?', 'Health & Body', 'open_ended', 'factual', 'one_time', ARRAY['blood_type','health']),
  ('food_allergies', 'What foods are you allergic to?', 'Health & Body', 'open_ended', 'factual', 'annually', ARRAY['allergies','health']),
  ('medication_allergies', 'Are you allergic to any medications?', 'Health & Body', 'open_ended', 'factual', 'annually', ARRAY['allergies','health']),
  ('chronic_conditions', 'What chronic conditions have you been diagnosed with?', 'Health & Body', 'open_ended', 'factual', 'annually', ARRAY['conditions','health']),
  ('regular_medications', 'What medications do you take regularly?', 'Health & Body', 'open_ended', 'factual', 'quarterly', ARRAY['medications','health']),
  ('family_health_conditions', 'Which health conditions run in your immediate family?', 'Health & Body', 'open_ended', 'factual', 'annually', ARRAY['family','health']),
  ('height', 'How tall are you?', 'Health & Body', 'open_ended', 'factual', 'annually', ARRAY['height','body']),
  ('weight', 'What is your current weight?', 'Health & Body', 'open_ended', 'factual', 'monthly', ARRAY['weight','body']),
  ('pronouns', 'What pronouns do you use?', 'Identity & Background', 'multiple_choice', 'factual', 'one_time', ARRAY['pronouns','identity']),
  ('spoken_languages', 'What languages do you speak?', 'Identity & Background', 'open_ended', 'factual', 'annually', ARRAY['languages','identity']),
  ('cultural_background', 'What cultural or ethnic background does your family identify with?', 'Identity & Background', 'open_ended', 'factual', 'one_time', ARRAY['culture','identity']),
  ('religion_or_spiritual_practice', 'What is your religion or spiritual practice now, if any?', 'Identity & Background', 'open_ended', 'factual', 'annually', ARRAY['religion','identity']),
  ('relationship_status', 'What is your relationship status?', 'Identity & Background', 'multiple_choice', 'factual', 'quarterly', ARRAY['relationships','identity']),
  ('sexual_orientation', 'How would you describe your sexual orientation?', 'Identity & Background', 'open_ended', 'preference', 'one_time', ARRAY['orientation','identity']),
  ('morning_person_or_night_owl', 'Are you a morning person or a night owl?', 'Preferences & Favorites', 'multiple_choice', 'preference', 'annually', ARRAY['routine','preferences']),
  ('favorite_season', 'What is your favorite season?', 'Preferences & Favorites', 'multiple_choice', 'preference', 'annually', ARRAY['seasons','preferences']),
  ('cat_or_dog_person', 'Are you more of a cat person or a dog person?', 'Preferences & Favorites', 'multiple_choice', 'preference', 'annually', ARRAY['pets','preferences']),
  ('beach_or_mountains', 'Do you prefer the beach or the mountains?', 'Preferences & Favorites', 'multiple_choice', 'preference', 'annually', ARRAY['travel','preferences']),
  ('cook_or_order_in', 'Do you prefer to cook or to order in?', 'Preferences & Favorites', 'multiple_choice', 'preference', 'annually', ARRAY['food','preferences']),
  ('favorite_cuisine', 'What is your favorite cuisine?', 'Preferences & Favorites', 'open_ended', 'preference', 'annually', ARRAY['food','preferences']),
  ('food_never_eaten', 'What food will you not eat under any circumstances?', 'Preferences & Favorites', 'open_ended', 'factual', 'annually', ARRAY['food','preferences']),
  ('longest_hobby', 'Which hobby have you kept the longest, and for how many years?', 'Interests & Culture', 'open_ended', 'narrative', 'annually', ARRAY['hobbies','interests']),
  ('skill_in_progress', 'What skill are you trying to get better at this year?', 'Interests & Culture', 'open_ended', 'factual', 'annually', ARRAY['skills','interests']),
  ('volunteering', 'Do you volunteer for any organization?', 'Interests & Culture', 'yes_no', 'factual', 'annually', ARRAY['volunteering','interests']),
  ('languages_learning', 'Which languages are you learning, if any?', 'Interests & Culture', 'open_ended', 'factual', 'annually', ARRAY['languages','interests']),
  ('sports_followed', 'What sports do you follow?', 'Interests & Culture', 'open_ended', 'factual', 'annually', ARRAY['sports','interests']),
  ('birth_city', 'What city were you born in?', 'Places & Travel', 'open_ended', 'factual', 'one_time', ARRAY['birthplace','places']),
  ('childhood_city', 'In which city did you spend most of your childhood?', 'Places & Travel', 'open_ended', 'factual', 'one_time', ARRAY['childhood','places']),
  ('childhood_home_memory', 'What do you remember most about the home you grew up in?', 'Home & Daily Life', 'open_ended', 'narrative', 'one_time', ARRAY['childhood','home']);

-- 1. ADOPT.
--
-- DISTINCT ON picks exactly one row per key: the catalogue has accumulated
-- near-duplicates over several seed passes, and two rows with the same text
-- both reaching for one key would violate questions_question_key_owner_uniq.
-- Prefer the row a seed migration wrote, then the active one, then the oldest.
-- The `NOT EXISTS` guard is what makes a re-run a no-op — on the second pass
-- the key is already taken, by the row that took it the first time.
WITH adopt AS (
  SELECT DISTINCT ON (c.question_key)
         c.question_key,
         c.question_category,
         c.question_type,
         c.answer_tier,
         q.question_id
    FROM _curated_life_details c
    JOIN ci.questions q
      ON lower(btrim(q.question_text)) = lower(btrim(c.question_text))
     AND q.is_private_to IS NULL
     AND q.question_key IS NULL
   WHERE NOT EXISTS (
     SELECT 1
       FROM ci.questions k
      WHERE k.question_key = c.question_key
        AND k.is_private_to IS NULL
   )
   ORDER BY c.question_key, q.is_seed_question DESC, q.is_active DESC, q.created_at ASC, q.question_id ASC
)
UPDATE ci.questions q
   SET question_key      = a.question_key,
       question_category = a.question_category,
       question_type     = a.question_type,
       answer_tier       = a.answer_tier,
       is_active         = true,
       updated_at        = now()
  FROM adopt a
 WHERE q.question_id = a.question_id;

-- 2. SEED.
INSERT INTO ci.questions
  (question_key, question_text, question_category, question_type, answer_tier,
   frequency_recommendation, context_tags, is_seed_question, created_by_llm, is_active)
SELECT c.question_key, c.question_text, c.question_category, c.question_type, c.answer_tier,
       c.frequency_recommendation, c.context_tags, true, false, true
  FROM _curated_life_details c
 WHERE NOT EXISTS (
   SELECT 1
     FROM ci.questions q
    WHERE q.question_key = c.question_key
      AND q.is_private_to IS NULL
 );

-- 3. FORKS.
UPDATE ci.questions f
   SET question_key = o.question_key,
       updated_at   = now()
  FROM ci.questions o
 WHERE f.forked_from_question_id = o.question_id
   AND o.question_key IS NOT NULL
   AND f.question_key IS NULL;

-- 4. ASSERT.
--
-- The client half of this contract cannot tell a missing row from an
-- unanswered one — that is precisely how the uuid version of this bug stayed
-- invisible for as long as it did. So the migration refuses to report success
-- on a half-seeded catalogue: better a failed deploy naming the keys than a
-- section that renders and quietly saves nothing.
DO $$
DECLARE
  missing TEXT[];
BEGIN
  SELECT array_agg(c.question_key ORDER BY c.question_key)
    INTO missing
    FROM _curated_life_details c
   WHERE NOT EXISTS (
     SELECT 1
       FROM ci.questions q
      WHERE q.question_key = c.question_key
        AND q.is_private_to IS NULL
        AND q.is_active
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Life details: % curated question(s) have no active shared row after seeding: %',
      array_length(missing, 1), array_to_string(missing, ', ');
  END IF;
END $$;

-- migrate:down
-- Only the keys are released; no row is deleted and no answer is touched.
-- Nothing here records which rows step 1 adopted versus which step 2 inserted,
-- so a down-path that deleted "what this migration added" would have to guess,
-- and guessing wrong takes real answers with it (ci.answers cascades from
-- ci.questions). An unkeyed curated question is the state this migration found
-- the database in, which is the honest thing to restore. Dropping the column
-- outright is 20260824234626's down-path, not this one's.
UPDATE ci.questions
   SET question_key = NULL,
       updated_at   = now()
 WHERE question_key IN (
   'blood_type', 'food_allergies', 'medication_allergies', 'chronic_conditions',
   'regular_medications', 'family_health_conditions', 'height', 'weight',
   'pronouns', 'spoken_languages', 'cultural_background', 'religion_or_spiritual_practice',
   'relationship_status', 'sexual_orientation', 'morning_person_or_night_owl',
   'favorite_season', 'cat_or_dog_person', 'beach_or_mountains', 'cook_or_order_in',
   'favorite_cuisine', 'food_never_eaten', 'longest_hobby', 'skill_in_progress',
   'volunteering', 'languages_learning', 'sports_followed', 'birth_city',
   'childhood_city', 'childhood_home_memory'
 );
