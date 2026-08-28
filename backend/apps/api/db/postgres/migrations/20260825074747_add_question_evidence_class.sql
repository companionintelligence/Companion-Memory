-- migrate:up
--
-- Marks the questions the appliance can never answer for you, so it stops
-- trying — and so the product can ask you directly instead.
--
-- WHY. The answer-inference job grounds its answers in the owner's own
-- imported corpus: email, messages, browser history, calendar, receipts,
-- media. That corpus contains no medical records, no tape measure and no
-- reading of the label on the boiler. Asked "What is your blood type?" the
-- model has nothing to retrieve (a probe of the 907k-row search index found
-- 0 hits for ring size, glove size, dominant hand, CPAP and resting heart
-- rate, and 2 lexical-noise hits for blood type), so it writes a refusal.
--
-- That refusal is not merely useless. `findUnansweredByUserId` treats any
-- non-empty `answer_text` as answered, so a stored "I don't have that
-- recorded" permanently occupies the slot, renders on the profile as though
-- the owner said it, and is then itself indexed and retrieved as evidence for
-- the next question. This migration clears those and stops them recurring.
--
-- CLASSIFIED BY TEXT, NOT BY ID. The catalogue is seeded by
-- 20260824233929_expand_reflections_catalogue without explicit primary keys,
-- so `question_id` is generated per install (ci.gen_uuid_v7()). A list of
-- UUIDs collected on one appliance is meaningless on every other one and
-- would silently no-op. Patterns travel; ids do not.
--
-- DELIBERATELY CONSERVATIVE. The patterns below catch ~77 of the ~243
-- questions a manual review judged unanswerable — under a third. That is the
-- intended direction of the error. Wrongly marking a question `hand_entry`
-- means it is never attempted again; leaving one `traceable` merely means the
-- job tries, scores itself low, and the existing confidence floor discards
-- the result. Precision on the sample was 97.5%. Widen this later from
-- observed refusals, which are evidence rather than guesswork.

ALTER TABLE ci.questions
  ADD COLUMN evidence_class text NOT NULL DEFAULT 'traceable'
  CHECK (evidence_class IN ('traceable', 'hand_entry'));

COMMENT ON COLUMN ci.questions.evidence_class IS
  'traceable = the appliance may attempt this from the owner''s corpus; '
  'hand_entry = only the owner can supply it, so never send it to inference.';

-- Body, medical and document facts: nothing in an inbox measures your ring
-- size or reads your blood pressure. `pharmacy` and `what time of day` are
-- excluded because those ARE traceable (receipts, calendar).
UPDATE ci.questions
   SET evidence_class = 'hand_entry', updated_at = now()
 WHERE question_text !~* '(pharmacy|what time of day)'
   AND question_text ~* '(blood type|blood pressure|resting heart rate|allergic|allergies'
                        '|epipen|medication|prescription|pacemaker|implant|cpap|medical alert'
                        '|organ donor|colorblind|braces|retainer|night guard|migraine'
                        '|motion sick|snore|birthmark|scars|piercing|tattoo|dietary restriction'
                        '|food intolerance|recreational drug|nicotine|pill organizer'
                        '|physical therapy|standing injury|shoe size|ring size|glove size'
                        '|hat size|shirt size|pants size|trouser size|eye color|hair color'
                        '|dominant hand|how tall|your weight|wear glasses|contact lens)';

-- Household configuration: the make of your stove and the location of your
-- breaker panel are facts about a building, and nothing digital records them.
UPDATE ci.questions
   SET evidence_class = 'hand_entry', updated_at = now()
 WHERE question_text ~* '(your home have|home wifi|thermostat|breaker panel|square feet'
                        '|home built|mattress|coffee maker|heating does|stove do you'
                        '|solar panel|home security system|printer at home|smart speaker'
                        '|yard or outdoor|delivery drivers leave|put your keys|side of the bed'
                        '|how many bedrooms|which floor is your home|postal or zip'
                        '|park your car at home|electric vehicle charger|do your laundry'
                        '|above your desk|local park called)';

-- Rating scales. Two earlier curation passes removed this shape because a
-- number between 1 and 10 is not a fact about a person that anything can act
-- on; these survived by phrasing ("Rate how well you cope with jet lag").
-- Retired outright rather than reclassified — there is nothing to ask.
UPDATE ci.questions
   SET is_active = false, updated_at = now()
 WHERE is_active
   AND question_text ~* '(scale of 1|scale of one|from one to ten|1-10|rate how)'
   AND NOT EXISTS (SELECT 1 FROM ci.answers a WHERE a.question_id = ci.questions.question_id);

-- Clear the refusals already sitting in answer slots. Scoped to machine-written
-- rows at or below the discard floor, so nothing a person typed is touched.
DELETE FROM ci.answers
 WHERE answer_source = 'inferred'
   AND answer_confidence IS NOT NULL
   AND answer_confidence <= 0.3;

CREATE INDEX questions_evidence_class_idx
    ON ci.questions (evidence_class)
 WHERE is_active;

-- migrate:down
DROP INDEX IF EXISTS ci.questions_evidence_class_idx;
ALTER TABLE ci.questions DROP COLUMN IF EXISTS evidence_class;
