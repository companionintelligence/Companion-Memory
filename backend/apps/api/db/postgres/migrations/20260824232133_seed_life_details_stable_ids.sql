-- migrate:up
-- The Self page's "Life details" grid (frontend/apps/web/src/pages/SelfPage/
-- sections/lifeDetails.ts) hardcodes 29 question UUIDs directly in client
-- code, captured from whatever database they were curated against. Every
-- other row that migration inserted (20260824083722_seed_life_details_
-- questions.sql) relies on ci.gen_uuid_v7()'s default, which mints a NEW
-- random id each time it runs — so on any OTHER appliance (a fresh worktree,
-- CI, a new install) those ids never match a real row: the grid renders its
-- 29 questions from the hardcoded list regardless, but every answer attempt
-- (manual or LLM-inferred) resolves `question_id` to nothing and silently
-- no-ops. Confirmed on this database: 27 of the 29 texts had no row at all
-- under any id, and the 2 that did ("What is your current weight?",
-- "How would you describe your sexual orientation?", from that same prior
-- migration's dynamic insert) existed under different, non-matching ids.
--
-- Fix: reconcile any existing row for these exact texts onto the id the
-- frontend expects, then seed everything still missing under its expected
-- id. Idempotent (ON CONFLICT DO NOTHING) and safe to re-run.

-- Drop a same-text row sitting under the WRONG id, so the insert below can
-- take that id without colliding with question_text as a de-facto duplicate.
-- Only when nobody has touched it yet, matching this repo's established rule
-- for editing a seed question in place.
DELETE FROM ci.questions q
 WHERE lower(btrim(q.question_text)) IN (
         lower(btrim('What is your current weight?')),
         lower(btrim('How would you describe your sexual orientation?'))
       )
   AND q.question_id NOT IN ('1656186e-c210-42a0-bd7b-9407c408a125', '5a498ece-079d-4da6-a28b-f9182f0495e1')
   AND NOT EXISTS (SELECT 1 FROM ci.answers a WHERE a.question_id = q.question_id)
   AND NOT EXISTS (SELECT 1 FROM ci.feed_queue f WHERE f.question_id = q.question_id);

INSERT INTO ci.questions
  (question_id, question_text, question_category, question_type, answer_tier,
   is_seed_question, created_by_llm, is_active)
VALUES
  ('e87d2be3-28f3-4916-ab12-fda1931c2479', 'What is your blood type?', 'Health & Body', 'open_ended', 'factual', true, false, true),
  ('19643a63-47e5-4963-8222-c734fba9d6d8', 'What foods are you allergic to?', 'Health & Body', 'open_ended', 'factual', true, false, true),
  ('de991610-d97b-48ee-9e71-e717afac8b7a', 'Are you allergic to any medications?', 'Health & Body', 'open_ended', 'factual', true, false, true),
  ('b61394b3-69d6-45d6-bf92-5418789839f0', 'What chronic conditions have you been diagnosed with?', 'Health & Body', 'open_ended', 'factual', true, false, true),
  ('c133b0cf-097b-440d-82d8-737115cca9db', 'What medications do you take regularly?', 'Health & Body', 'open_ended', 'factual', true, false, true),
  ('e87ffe6e-bd18-4297-8da3-6d7c9c187759', 'Which health conditions run in your immediate family?', 'Health & Body', 'open_ended', 'factual', true, false, true),
  ('1aa9360b-dcdc-4616-b7d7-22f7770619eb', 'How tall are you?', 'Health & Body', 'open_ended', 'factual', true, false, true),
  ('1656186e-c210-42a0-bd7b-9407c408a125', 'What is your current weight?', 'Health & Body', 'open_ended', 'factual', true, false, true),
  ('4a1e9f9c-6aed-426d-9f3b-76b2cd22154f', 'What pronouns do you use?', 'Identity & Background', 'multiple_choice', 'factual', true, false, true),
  ('bacfc834-bf94-4d64-8808-2f3dd0bd861e', 'What languages do you speak?', 'Identity & Background', 'open_ended', 'factual', true, false, true),
  ('cc0cb904-0de6-42c5-b10e-02600c35d87f', 'What cultural or ethnic background does your family identify with?', 'Identity & Background', 'open_ended', 'factual', true, false, true),
  ('e71b34e7-ea4d-49bb-89f3-f526a86c2519', 'What is your religion or spiritual practice now, if any?', 'Identity & Background', 'open_ended', 'factual', true, false, true),
  ('814650fc-d5b7-4d21-8a0b-1882726458c4', 'What is your relationship status?', 'Identity & Background', 'multiple_choice', 'factual', true, false, true),
  ('5a498ece-079d-4da6-a28b-f9182f0495e1', 'How would you describe your sexual orientation?', 'Identity & Background', 'open_ended', 'preference', true, false, true),
  ('bf834f6c-0b59-4fab-8960-503e1b94694a', 'Are you a morning person or a night owl?', 'Preferences & Favorites', 'multiple_choice', 'preference', true, false, true),
  ('e4ec3776-fb7d-498f-b48f-d26f0df269f0', 'What is your favorite season?', 'Preferences & Favorites', 'multiple_choice', 'preference', true, false, true),
  ('4136554c-6be1-4c21-8dd4-ea462cd76117', 'Are you more of a cat person or a dog person?', 'Preferences & Favorites', 'multiple_choice', 'preference', true, false, true),
  ('8ad777b3-580a-4850-90d0-5b553ba3d1d4', 'Do you prefer the beach or the mountains?', 'Preferences & Favorites', 'multiple_choice', 'preference', true, false, true),
  ('a57a5f8a-4f28-401b-b798-1b39bc897cab', 'Do you prefer to cook or to order in?', 'Preferences & Favorites', 'multiple_choice', 'preference', true, false, true),
  ('1e00a3c2-e071-4360-8a9a-e020baeace00', 'What is your favorite cuisine?', 'Preferences & Favorites', 'open_ended', 'preference', true, false, true),
  ('94ffe494-a094-4d6d-bc3c-69672d3373b0', 'What food will you not eat under any circumstances?', 'Preferences & Favorites', 'open_ended', 'factual', true, false, true),
  ('8ac610c9-27aa-4505-b79f-bc89c4f50dca', 'Which hobby have you kept the longest, and for how many years?', 'Interests & Culture', 'open_ended', 'narrative', true, false, true),
  ('a8b97245-cac2-4771-949f-6a4bb1ea2f28', 'What skill are you trying to get better at this year?', 'Interests & Culture', 'open_ended', 'factual', true, false, true),
  ('e9afce2b-acb7-4a73-a1c0-3394add95b52', 'Do you volunteer for any organization?', 'Interests & Culture', 'yes_no', 'factual', true, false, true),
  ('6ea30fa3-b3d5-4bee-b920-87863627f4b1', 'Which languages are you learning, if any?', 'Interests & Culture', 'open_ended', 'factual', true, false, true),
  ('a11f73d3-a7cb-4170-890e-4ec44d295f0f', 'What sports do you follow?', 'Interests & Culture', 'open_ended', 'factual', true, false, true),
  ('8565f9fa-965a-49c4-81fb-6ab8b3a4ee70', 'What city were you born in?', 'Places & Travel', 'open_ended', 'factual', true, false, true),
  ('d5e6e582-c0e3-40c5-aa2c-5e100c7c384d', 'In which city did you spend most of your childhood?', 'Places & Travel', 'open_ended', 'factual', true, false, true),
  ('99c65199-4185-4e38-ae96-69e542b2531f', 'What do you remember most about the home you grew up in?', 'Home & Daily Life', 'open_ended', 'narrative', true, false, true)
ON CONFLICT (question_id) DO NOTHING;

-- migrate:down
DELETE FROM ci.questions q
 WHERE q.question_id IN (
   'e87d2be3-28f3-4916-ab12-fda1931c2479', '19643a63-47e5-4963-8222-c734fba9d6d8',
   'de991610-d97b-48ee-9e71-e717afac8b7a', 'b61394b3-69d6-45d6-bf92-5418789839f0',
   'c133b0cf-097b-440d-82d8-737115cca9db', 'e87ffe6e-bd18-4297-8da3-6d7c9c187759',
   '1aa9360b-dcdc-4616-b7d7-22f7770619eb', '1656186e-c210-42a0-bd7b-9407c408a125',
   '4a1e9f9c-6aed-426d-9f3b-76b2cd22154f', 'bacfc834-bf94-4d64-8808-2f3dd0bd861e',
   'cc0cb904-0de6-42c5-b10e-02600c35d87f', 'e71b34e7-ea4d-49bb-89f3-f526a86c2519',
   '814650fc-d5b7-4d21-8a0b-1882726458c4', '5a498ece-079d-4da6-a28b-f9182f0495e1',
   'bf834f6c-0b59-4fab-8960-503e1b94694a', 'e4ec3776-fb7d-498f-b48f-d26f0df269f0',
   '4136554c-6be1-4c21-8dd4-ea462cd76117', '8ad777b3-580a-4850-90d0-5b553ba3d1d4',
   'a57a5f8a-4f28-401b-b798-1b39bc897cab', '1e00a3c2-e071-4360-8a9a-e020baeace00',
   '94ffe494-a094-4d6d-bc3c-69672d3373b0', '8ac610c9-27aa-4505-b79f-bc89c4f50dca',
   'a8b97245-cac2-4771-949f-6a4bb1ea2f28', 'e9afce2b-acb7-4a73-a1c0-3394add95b52',
   '6ea30fa3-b3d5-4bee-b920-87863627f4b1', 'a11f73d3-a7cb-4170-890e-4ec44d295f0f',
   '8565f9fa-965a-49c4-81fb-6ab8b3a4ee70', 'd5e6e582-c0e3-40c5-aa2c-5e100c7c384d',
   '99c65199-4185-4e38-ae96-69e542b2531f'
 )
   AND NOT EXISTS (SELECT 1 FROM ci.answers a WHERE a.question_id = q.question_id)
   AND NOT EXISTS (SELECT 1 FROM ci.feed_queue f WHERE f.question_id = q.question_id);
