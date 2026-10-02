-- migrate:up
--
-- Gives back the protection a reworded sensitive question lost. Repairs the
-- forks that were minted without their origin's `evidence_class`.
--
-- WHAT WENT WRONG. A user's edit to a shared catalogue row mints a private copy
-- of it (QuestionService.forkSharedQuestion, see 20260819051642). The copy was
-- built field by field and `evidence_class` was not one of the fields, so the
-- INSERT left it out and the copy took the column default, `traceable` - even
-- when the row it was copied from is `hand_entry`.
--
-- WHY IT MATTERS. Both inference selectors skip `hand_entry` questions
-- (20260825074747), and a user's copy hides its origin from them
-- (`excludeForkedOriginsSql`). So once someone reworded "What is your blood
-- type?" the origin was gone from their selections and the only copy left was
-- `traceable`: the job would try to answer it from their corpus, which is what
-- 20260825185434 exists to stop for sexual orientation, medical diagnoses,
-- weight and the rest.
--
-- WHAT THIS DOES. Every fork of a `hand_entry` question that is still
-- `traceable` becomes `hand_entry`, and the machine-written answers on exactly
-- those rows are deleted: whatever the job wrote for the owner after the copy
-- existed, and anything written for the origin that adoptOwnHistory carried
-- across when the copy was made. Nothing the owner typed is touched, and
-- nothing that is not an inference: a person's own text, and their correction
-- of an inferred answer, is `user_input` (AnswerService.update), and `observed`
-- and `imported` rows stay too.
--
-- IT ONLY TIGHTENS. A fork that is `hand_entry` under a `traceable` origin was
-- classified on its own wording and is left as it is. No origin row is touched,
-- and neither is a `hand_entry` fork's answers: this purges what it repaired.
--
-- MATCHED BY THE FORK EDGE, NOT BY TEXT. 20260825185434 classifies by pattern,
-- and a pattern cannot find these rows: a fork exists because its wording was
-- changed. `forked_from_question_id` is what every fork carries. A fork whose
-- origin has since been deleted has no edge left (ON DELETE SET NULL) and cannot
-- be traced, so it is left alone.
--
-- One statement, so the rows whose class is repaired and the rows whose answers
-- are purged cannot disagree: the DELETE reads what the UPDATE returned. A
-- re-run matches nothing, because a repaired fork is `hand_entry`.

WITH repaired AS (
  UPDATE ci.questions fork
     SET evidence_class = 'hand_entry', updated_at = now()
    FROM ci.questions origin
   WHERE origin.question_id = fork.forked_from_question_id
     AND origin.evidence_class = 'hand_entry'
     AND fork.evidence_class <> 'hand_entry'
  RETURNING fork.question_id
)
DELETE FROM ci.answers a
 USING repaired r
 WHERE a.question_id = r.question_id
   AND a.answer_source = 'inferred';

-- migrate:down
-- Intentionally irreversible, for the reason 20260825185434's down is: putting
-- these forks back to `traceable` would license the inference job to guess at
-- facts nobody may guess at on a person's behalf. It could not be done
-- selectively anyway - once repaired, these rows are indistinguishable from
-- forks that were `hand_entry` already - and the answers it deleted were
-- guesses, not data. Reclassify a specific fork by hand if one is genuinely safe.
