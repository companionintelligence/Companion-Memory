import {
  expandList,
  functionalCatalogFold,
  legacySeedRows,
  migrationSection,
  ratingScalePattern,
  REACTIVATION_MIGRATION,
  reactivationDownFold,
  reactivationDownIds,
  reactivationList,
  textKey,
} from './expandedReflectionsMigration';

/**
 * 20260930171822_reactivate_expanded_reflections_legacy_rows carries data copied
 * from three other migrations: the expand list, the ids 20251214231106 pinned,
 * and the category fold 20260818235602 applied. Nothing checks a copy like that
 * at runtime. A drifted text matches no row, a wrong id repairs nothing, and a
 * wrong fold rolls a row back under the wrong category, all in silence. So the
 * files are parsed and diffed here, at `yarn test`, with no database needed.
 * What the SQL does to real rows is proved against Postgres in
 * expandedReflectionsReactivation.integration.spec.ts.
 */
describe(`${REACTIVATION_MIGRATION} data`, () => {
  const expand = expandList();
  const reactivation = reactivationList();
  const legacyByText = new Map(legacySeedRows().map((row) => [textKey(row.questionText), row]));

  it('carries the expand migration’s list row for row', () => {
    expect(expand).toHaveLength(528);
    expect(
      reactivation.map(({ questionText, questionCategory, questionType, answerTier }) => ({
        questionText,
        questionCategory,
        questionType,
        answerTier,
      })),
    ).toEqual(expand);
  });

  it('names, for every text, exactly the id 20251214231106 pinned to it', () => {
    // A text that seed pinned twice would leave the choice of id to Map order.
    const expandKeys = new Set(expand.map((row) => textKey(row.questionText)));
    const pinnedTwice = legacySeedRows()
      .map((row) => textKey(row.questionText))
      .filter((key, index, keys) => expandKeys.has(key) && keys.indexOf(key) !== index);

    expect(pinnedTwice).toEqual([]);

    const mismatches = reactivation.filter(
      (row) => row.legacyQuestionId !== (legacyByText.get(textKey(row.questionText))?.questionId ?? null),
    );

    expect(mismatches).toEqual([]);
    expect(reactivation.filter((row) => row.legacyQuestionId != null)).toHaveLength(421);
  });

  it('rolls back exactly the ids its up may touch', () => {
    const upIds = reactivation.flatMap((row) => (row.legacyQuestionId == null ? [] : [row.legacyQuestionId]));

    expect([...reactivationDownIds()].sort()).toEqual([...upIds].sort());
  });

  it('folds each category back to where 20260818235602 step 4 put that row', () => {
    const catalogFold = functionalCatalogFold();
    const downFold = reactivationDownFold();

    const wrong = reactivation.flatMap((row) => {
      if (row.legacyQuestionId == null) {
        return [];
      }

      const seeded = legacyByText.get(textKey(row.questionText))!.questionCategory;
      const expected = catalogFold.get(seeded) ?? seeded;
      const restored = downFold.get(row.questionCategory) ?? row.questionCategory;

      return restored === expected ? [] : [{ text: row.questionText, expected, restored }];
    });

    expect(wrong).toEqual([]);
  });

  it('keeps retired the rating scales 20260825074747 retires', () => {
    expect(migrationSection(REACTIVATION_MIGRATION, 'up')).toContain(
      `AND q.question_text !~* '${ratingScalePattern()}'`,
    );
  });
});
