/**
 * The order the inference rotation works through `ci.questions`.
 *
 * Two selectors pick the next question worth an inference slot:
 * `QuestionService.findUnansweredByUserId` (AnswerInferenceCron) and
 * `SmartRotationListener.findNextUnansweredQuestionId` (the smart-rotation
 * `answer_infer` work). They read the same catalogue and the same pg-boss
 * attempt history, so they take one definition of order from here rather than
 * two copies — the listener's copy had already drifted and never ranked by tier.
 *
 * Each caller leads with its own attempt-history key (never-attempted first,
 * then least recently attempted) and follows it with
 * {@link QUESTION_ROTATION_ORDER_SQL}.
 */

/**
 * Ask the functional questions first.
 *
 * `ci.questions.answer_tier` splits the catalogue into questions that settle a
 * fact ("What foods are you allergic to?"), questions that record a taste
 * ("Window or aisle?"), and questions that ask for a story ("How did you end up
 * in the city you live in now?"). A memory system earns the third kind by
 * getting the first two right, so every selector orders by this rank before it
 * applies its own tie-break.
 *
 * NULL sorts last, not first: an untiered row is a legacy question from the
 * pre-catalogue era, and those are exactly the abstract ones we do not want to
 * lead with. (Postgres defaults NULLs FIRST on DESC and LAST on ASC; spelling
 * the rank out as an integer avoids depending on that.)
 *
 * Expects the question row aliased `q`.
 */
export const TIER_RANK_SQL = `
  CASE q.answer_tier
    WHEN 'factual'    THEN 0
    WHEN 'preference' THEN 1
    WHEN 'narrative'  THEN 2
    ELSE 3
  END
`;

/**
 * Body of a `WITH … AS (…)` CTE placing every question in the catalogue's
 * round-robin, within its tier and its created_at batch:
 *
 * - `category_round` — 1 for its category's first question in written order
 *   (`seed_position`), 2 for the second, and so on;
 * - `category_position` — where its category starts in written order, which is
 *   the order categories take their turn within a round.
 *
 * WHY ROUND-ROBIN. The seed files list the catalogue category by category, so
 * written order alone would spend a fresh appliance's first hundred or so
 * factual inferences on Health & Body. A round takes each category's next
 * question in turn, so the first eight picks span all eight life areas, each
 * category still in the order it was written.
 *
 * WHY OVER THE WHOLE CATALOGUE. The ranks cover every question the rotation
 * could ever offer — active and not hand-entry — and NOT the questions a user
 * has left. That is what makes it rotate: once a category's first question is
 * answered or cooling down, its second is still round 2 and waits behind every
 * other category's round 1. Ranked over what is left instead, the second
 * question would become round 1 again and the first category would win every
 * round, which is plain written order. It also makes the order a property of
 * the catalogue: identical on every appliance that holds the same one.
 *
 * WHY NOT question_id. `ci.gen_uuid_v7()` minted the seeded catalogue random v4
 * ids on every install since the PG18 image, and a seed batch shares one
 * created_at, so ordering a batch by id was a different shuffle on every
 * appliance (see 20260930153606_add_questions_seed_position). The id survives
 * only as the last term of each ordering here, where it decides nothing unless
 * two rows agree on everything before it.
 *
 * A row with no `seed_position` — a user's own reflection, an LLM-written
 * question, a private copy, a seeded row whose text was edited after seeding —
 * ranks by text after the positioned rows of its batch. `COLLATE "C"` so that
 * order is the same whatever locale the database was initialised with.
 */
export const QUESTION_ROTATION_RANK_SQL = `
  SELECT
    r.question_id,
    ROW_NUMBER() OVER (
      PARTITION BY r.answer_tier, r.created_at, r.question_category
      ORDER BY r.seed_position ASC NULLS LAST, r.question_text COLLATE "C" ASC, r.question_id ASC
    ) AS category_round,
    MIN(r.seed_position) OVER (
      PARTITION BY r.answer_tier, r.created_at, r.question_category
    ) AS category_position
  FROM ci.questions r
  WHERE r.is_active = TRUE
    AND r.evidence_class <> 'hand_entry'
`;

/**
 * The ORDER BY terms that follow a caller's attempt-history key: tier, then
 * batch age (oldest seed first), then the round-robin.
 *
 * Expects the question row aliased `q` and {@link QUESTION_ROTATION_RANK_SQL}
 * LEFT JOINed as `qr` on `question_id`. LEFT, so a candidate the ranks do not
 * cover is still offered — after the ranked questions of its batch — rather
 * than silently dropped if a caller's filter and the ranks' ever disagree.
 */
export const QUESTION_ROTATION_ORDER_SQL = `
  ${TIER_RANK_SQL} ASC,
  q.created_at ASC,
  qr.category_round ASC NULLS LAST,
  qr.category_position ASC NULLS LAST,
  q.question_category COLLATE "C" ASC NULLS LAST,
  q.question_text COLLATE "C" ASC,
  q.question_id ASC
`;
