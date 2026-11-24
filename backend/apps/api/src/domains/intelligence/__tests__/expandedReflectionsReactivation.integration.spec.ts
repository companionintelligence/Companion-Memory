import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';

import {
  functionalCatalogFold,
  legacySeedRows,
  migrationSection,
  REACTIVATION_MIGRATION,
  reactivationList,
  textKey,
} from './expandedReflectionsMigration';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The questions the expand migration skipped are live, proved on real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 20260824233929_expand_reflections_catalogue guarded its INSERT with a
 * NOT EXISTS on question_text that ignores is_active, so on every install it
 * skipped 421 of its 528 texts: the rows 20251214231106 had seeded and
 * 20260818235602 had retired. 20260930171822 repairs those rows in place.
 *
 * The scratch database runs every migration from empty, so the first tests
 * read what a fresh install ends up with. The rest apply the migration's two
 * halves verbatim from disk, around fixtures its guards must respect. A unit
 * test cannot stand in: the defect is in the database, not in a function.
 * expandedReflectionsReactivation.test.ts checks the copied data against its
 * source files.
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[expandedReflectionsReactivation.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

const USER = '11111111-1111-4111-8111-111111111111';

const LIST = reactivationList();

/** The 421 texts the expand insert skipped, by the id 20251214231106 pinned. */
const LEGACY = new Map(
  LIST.flatMap((row) => (row.legacyQuestionId == null ? [] : [[row.legacyQuestionId, row]])),
);

/** 20260825074747 retires rating scales outright; the repair must not revive this one. */
const RATING_SCALE_ID = [...LEGACY].find(([, row]) => /scale of 1\b/i.test(row.questionText))![0];

/** The 107 texts the expand insert did write. */
const INSERTED_TEXTS = LIST.filter((row) => row.legacyQuestionId == null).map((row) =>
  textKey(row.questionText),
);

/** Each legacy row's category as 20251214231106 seeded it, and the fold 20260818235602 step 4 applied. */
const SEEDED_CATEGORY = new Map(legacySeedRows().map((row) => [row.questionId, row.questionCategory]));
const FOLD = functionalCatalogFold();

interface QuestionRow {
  question_id: string;
  question_text: string;
  question_category: string | null;
  question_type: string | null;
  answer_tier: string | null;
  is_active: boolean;
  is_seed_question: boolean;
  created_by_llm: boolean;
  created_at: string;
}

const COLUMNS = `question_id::text AS question_id, question_text, question_category, question_type,
                 answer_tier, is_active, is_seed_question, created_by_llm, created_at::text AS created_at`;

/** What the repair makes of a legacy row: the expand list's row, live and seed-labelled. */
function repaired(id: string) {
  const row = LEGACY.get(id)!;

  return {
    question_category: row.questionCategory,
    question_type: row.questionType,
    answer_tier: row.answerTier,
    is_active: true,
    is_seed_question: true,
    created_by_llm: false,
  };
}

/** What 20260818235602 left of a legacy row, and what the down restores. */
function retired(id: string) {
  const seeded = SEEDED_CATEGORY.get(id)!;

  return {
    question_category: FOLD.get(seeded) ?? seeded,
    question_type: 'open_ended',
    answer_tier: null,
    is_active: false,
    is_seed_question: false,
    created_by_llm: true,
  };
}

function shape(row: QuestionRow) {
  const { question_category, question_type, answer_tier, is_active, is_seed_question, created_by_llm } = row;

  return { question_category, question_type, answer_tier, is_active, is_seed_question, created_by_llm };
}

describeWithDatabase(`${REACTIVATION_MIGRATION} (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  /** One half of the migration, the way dbmate runs it: whole, in one transaction. */
  async function apply(section: 'up' | 'down'): Promise<void> {
    const runner = scratch.dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.query(migrationSection(REACTIVATION_MIGRATION, section));
      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();

      throw err;
    } finally {
      await runner.release();
    }
  }

  async function legacyRows(): Promise<Map<string, QuestionRow>> {
    const rows = (await scratch.dataSource.query(
      `SELECT ${COLUMNS} FROM ci.questions WHERE question_id = ANY($1::uuid[])`,
      [[...LEGACY.keys()]],
    )) as QuestionRow[];

    return new Map(rows.map((row) => [row.question_id, row]));
  }

  /** Legacy rows whose shape differs from `expected(id)`, with what they hold instead. */
  async function mismatches(ids: string[], expected: (id: string) => ReturnType<typeof shape>) {
    const rows = await legacyRows();

    return ids.flatMap((id) => {
      const actual = shape(rows.get(id)!);

      return JSON.stringify(actual) === JSON.stringify(expected(id)) ? [] : [{ id, actual }];
    });
  }

  /** The shared rows the expand migration's own INSERT wrote. */
  async function insertedRows(): Promise<QuestionRow[]> {
    return (await scratch.dataSource.query(
      `SELECT ${COLUMNS} FROM ci.questions
        WHERE is_private_to IS NULL AND lower(btrim(question_text)) = ANY($1::text[])`,
      [INSERTED_TEXTS],
    )) as QuestionRow[];
  }

  const repairable = () => [...LEGACY.keys()].filter((id) => id !== RATING_SCALE_ID);

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'expanded reflections reactivation' });
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('leaves a fresh install with every expand-list question live, bar the rating scale', async () => {
    expect((await legacyRows()).size).toBe(421);
    expect(repairable()).toHaveLength(420);
    expect(await mismatches(repairable(), repaired)).toEqual([]);
    expect(await mismatches([RATING_SCALE_ID], retired)).toEqual([]);

    const inserted = await insertedRows();

    expect(inserted).toHaveLength(107);
    expect(inserted.every((row) => row.is_active && row.is_seed_question && !row.created_by_llm)).toBe(true);
  });

  it('asks no text twice', async () => {
    const twice = await scratch.dataSource.query(
      `SELECT lower(btrim(question_text)) AS text
         FROM ci.questions
        WHERE is_active AND is_private_to IS NULL AND lower(btrim(question_text)) = ANY($1::text[])
        GROUP BY 1
       HAVING count(*) > 1`,
      [LIST.map((row) => textKey(row.questionText))],
    );

    expect(twice).toEqual([]);
  });

  it("stamps the repaired rows into the expand migration's batch, not the legacy seed's", async () => {
    const batch = new Set((await insertedRows()).map((row) => row.created_at));

    expect(batch.size).toBe(1);

    const rows = await legacyRows();
    const stamps = new Set(repairable().map((id) => rows.get(id)!.created_at));

    expect(stamps).toEqual(batch);

    // The row it left alone still carries the legacy seed's time, which is older.
    const [{ older }] = (await scratch.dataSource.query(`SELECT $1::timestamptz < $2::timestamptz AS older`, [
      rows.get(RATING_SCALE_ID)!.created_at,
      [...batch][0],
    ])) as Array<{ older: boolean }>;

    expect(older).toBe(true);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const snapshot = async () =>
      scratch.dataSource.query(
        `SELECT ${COLUMNS}, updated_at::text AS updated_at FROM ci.questions ORDER BY question_id`,
      );

    const before = await snapshot();

    await apply('up');

    expect(await snapshot()).toEqual(before);
  });

  it('rolls back to the state 20260818235602 left, leaving the expand insert alone', async () => {
    await apply('down');

    expect(await mismatches([...LEGACY.keys()], retired)).toEqual([]);
    expect(
      (await insertedRows()).every((row) => row.is_active && row.is_seed_question && !row.created_by_llm),
    ).toBe(true);

    await apply('up');

    expect(await mismatches(repairable(), repaired)).toEqual([]);
  });

  it('skips a row somebody answered, queued, edited, owns or already asks, and one it did not retire', async () => {
    await apply('down');

    const [answered, queued, edited, twinned, owned, adopted, copied, forked] = repairable();
    const query = (sql: string, params: unknown[]) => scratch.dataSource.query(sql, params);

    await query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, 'Reflections', 'reflections@example.test')`,
      [USER],
    );
    await query(`INSERT INTO ci.answers (question_id, user_id, answer_text) VALUES ($1, $2, 'An answer.')`, [
      answered,
      USER,
    ]);
    await query(
      `INSERT INTO ci.feed_queue (feed_queue_id, user_id, question_id, item_type)
       VALUES (gen_random_uuid(), $2, $1, 'question')`,
      [queued, USER],
    );
    await query(`UPDATE ci.questions SET question_text = question_text || ' Why?' WHERE question_id = $1`, [
      edited,
    ]);
    // A live shared row already asking the same text: reviving the retired one would ask it twice.
    await query(
      `INSERT INTO ci.questions (question_text, question_category, question_type, is_seed_question, created_by_llm, is_active)
       SELECT question_text, question_category, question_type, true, false, true
         FROM ci.questions WHERE question_id = $1`,
      [twinned],
    );
    // Before copy-on-write (#2130) an edit could hand a shared row to one user via is_private_to.
    await query(`UPDATE ci.questions SET is_private_to = $2 WHERE question_id = $1`, [owned, USER]);
    // Seed-labelled and retired: not the shape 20260818235602 step 3 left, so retired by something else.
    await query(
      `UPDATE ci.questions SET is_seed_question = true, created_by_llm = false WHERE question_id = $1`,
      [adopted],
    );
    // Someone's own retired question with the same text, and someone's retired copy of a shared row.
    const [{ id: privateCopy }] = (await query(
      `INSERT INTO ci.questions (question_text, is_private_to, is_seed_question, created_by_llm, is_active)
       SELECT question_text, $2, false, true, false FROM ci.questions WHERE question_id = $1
       RETURNING question_id::text AS id`,
      [copied, USER],
    )) as Array<{ id: string }>;
    const [{ id: fork }] = (await query(
      `INSERT INTO ci.questions
         (question_text, question_type, is_private_to, forked_from_question_id, is_seed_question, created_by_llm, is_active)
       SELECT question_text, question_type, $2, question_id, false, false, false FROM ci.questions WHERE question_id = $1
       RETURNING question_id::text AS id`,
      [forked, USER],
    )) as Array<{ id: string }>;

    await apply('up');

    const skipped = [answered, queued, edited, twinned, owned, adopted];

    expect(await mismatches([answered, queued, edited, twinned, owned], retired)).toEqual([]);
    expect(
      await mismatches([adopted], (id) => ({
        ...retired(id),
        is_seed_question: true,
        created_by_llm: false,
      })),
    ).toEqual([]);
    expect(await mismatches([copied, forked], repaired)).toEqual([]);
    expect(
      await mismatches(
        repairable().filter((id) => !skipped.includes(id)),
        repaired,
      ),
    ).toEqual([]);

    const privateRows = (await query(
      `SELECT ${COLUMNS} FROM ci.questions WHERE question_id = ANY($1::uuid[])`,
      [[privateCopy, fork]],
    )) as QuestionRow[];

    expect(privateRows.map((row) => ({ active: row.is_active, tier: row.answer_tier }))).toEqual([
      { active: false, tier: null },
      { active: false, tier: null },
    ]);

    // And the down keeps a repaired question somebody has answered since.
    await query(`INSERT INTO ci.answers (question_id, user_id, answer_text) VALUES ($1, $2, 'Since.')`, [
      copied,
      USER,
    ]);
    await apply('down');

    expect(await mismatches([copied], repaired)).toEqual([]);
    expect(await mismatches([forked], retired)).toEqual([]);
  });
});
