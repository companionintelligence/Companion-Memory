-- migrate:up
--
-- Stops the appliance from GUESSING facts it must never guess.
--
-- `evidence_class` was introduced to spare the inference job questions its
-- corpus cannot ground. This migration adds the other reason a question must
-- never reach that job: some facts are too consequential to be wrong about,
-- however good the evidence looks.
--
-- Found live: `sexual_orientation`, `chronic_conditions`,
-- `family_health_conditions` and `weight` were all classed `traceable`, so the
-- job was licensed to infer someone's sexual orientation, their medical
-- diagnoses and their body weight from chat logs. It had already produced
--   "Which health conditions run in your immediate family?"
--     -> "There are doctors in my family."        (confidence 0.90)
-- by matching "doctors"/"family" lexically, and
--   "What chronic conditions have you been diagnosed with?"
--     -> "I have a medical condition that affects what I can eat and drink."
-- from a passing remark. A wrong guess about a diagnosis or an orientation is
-- not a low-quality answer; it is a claim about a person's life that they did
-- not make, rendered on their own profile as though they had.
--
-- These stay ASKABLE — the owner can answer any of them by hand, and the ones
-- that matter most (allergies, medications, emergency contact) are exactly the
-- rows only they can fill. What changes is that nothing writes them on their
-- behalf.
--
-- Matched on text rather than id: the catalogue is seeded without explicit
-- primary keys, so question_id is minted per install (see
-- 20260825074747_add_question_evidence_class for the full reasoning).

UPDATE ci.questions
   SET evidence_class = 'hand_entry', updated_at = now()
 WHERE evidence_class <> 'hand_entry'
   -- "What is your favorite non-alcoholic drink?" is not a health question.
   AND question_text !~* 'non-?alcoholic'
   AND question_text ~* '(sexual orientation|gender identity|are you (gay|straight|bisexual)'
                        '|your (current )?weight|how much do you weigh|body mass|\mbmi\M'
                        '|diagnos|chronic condition|medical condition|health conditions'
                        '|mental health|depress|anxiet|therap|psychiatr|medication'
                        '|disabilit|pregnan|fertilit|abortion|addiction|substance abuse'
                        '|alcoholic drinks|sobriety|\mhiv\M|\mstd\M|\msti\M)';

-- Anything the job already wrote for one of these is a guess about a
-- protected fact. Machine-written rows only — nothing the owner typed is
-- touched.
DELETE FROM ci.answers a
 USING ci.questions q
 WHERE q.question_id = a.question_id
   AND q.evidence_class = 'hand_entry'
   AND a.answer_source = 'inferred';

-- migrate:down
-- Intentionally irreversible: re-licensing the inference job to guess at
-- diagnoses and orientation is not a state worth being able to roll back into.
-- Reclassify individual rows by hand if a specific question is genuinely safe.
