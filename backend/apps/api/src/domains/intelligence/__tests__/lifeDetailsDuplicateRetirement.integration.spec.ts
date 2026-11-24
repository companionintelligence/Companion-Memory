import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ServiceContext } from '@ci/common/context';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { QuestionService } from '../services/QuestionService';
import { questionCatalogueQuerySchema } from '../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * One active shared row per curated Life-details question, proved against
 * real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 20260824232133_seed_life_details_stable_ids inserted 26 curated questions a
 * second time: its INSERT guards on the pinned `question_id`, not on the text
 * 20260818235602 had already seeded. 20260824234643 then keyed the older copy
 * and left the pinned one active and unkeyed. {@link MIGRATION} retires that
 * twin. Before it does, it moves the twin's answers, feed items, forks and open
 * context prompts onto the row that now stands for the question.
 *
 * Two databases' worth of claims, from one scratch database:
 *
 *  1. A FRESH INSTALL. `ScratchDatabase.create()` applies every migration from
 *     empty, this one included, so the first block asserts the end state a new
 *     appliance gets. That includes the global invariant the migration's own
 *     closing assertion deliberately does not check, because a real appliance
 *     can hold duplicates that are not this migration's to decide.
 *  2. AN APPLIANCE THAT LIVED WITH THE DUPLICATES. The down path puts the 26
 *     twins back, which is also the first test of the down path. The suite then
 *     seeds what five weeks of use could have left on either copy and re-runs
 *     the up half. Placement is asserted row by row, and the Self page's view
 *     through the real QuestionService.findCatalogue. After that come
 *     idempotency, an exact down path, and proof that the closing assertion
 *     can actually fire.
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const MIGRATION = '20260930171432_retire_duplicate_life_details_questions.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/postgres/migrations');

/** One half of the migration, split where dbmate splits it. */
function migrationHalf(half: 'up' | 'down'): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  if (down === -1) {
    throw new Error(`${MIGRATION} has no "-- migrate:down" marker.`);
  }

  return half === 'up' ? sql.slice(0, down) : sql.slice(down);
}

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[lifeDetailsDuplicateRetirement.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

const USERS = {
  one: '11111111-1111-4111-8111-111111111111',
  two: '22222222-2222-4222-8222-222222222222',
  three: '33333333-3333-4333-8333-333333333333',
};

/** Fixed ids, so "this row moved and kept its uuid" is a thing the assertions can state. */
const ANSWERS = {
  pronounsOnTwin: 'a0000000-0000-4000-8000-000000000001',
  chronotypeOnKept: 'a0000000-0000-4000-8000-000000000002',
  chronotypeOnTwin: 'a0000000-0000-4000-8000-000000000003',
  relationshipOnTwin: 'a0000000-0000-4000-8000-000000000004',
  relationshipOnKept: 'a0000000-0000-4000-8000-000000000005',
  sportsOnFork: 'a0000000-0000-4000-8000-000000000006',
  sportsOnKept: 'a0000000-0000-4000-8000-000000000007',
  languagesOnKept: 'a0000000-0000-4000-8000-000000000008',
  seasonOnTwin: 'a0000000-0000-4000-8000-000000000009',
  seasonOnTwinByForker: 'a0000000-0000-4000-8000-00000000000a',
};

const FEED = {
  birthCityOnKept: 'f0000000-0000-4000-8000-000000000001',
  birthCityOnTwin: 'f0000000-0000-4000-8000-000000000002',
  birthCityOnTwinAlone: 'f0000000-0000-4000-8000-000000000003',
  sportsOnTwin: 'f0000000-0000-4000-8000-000000000004',
  sportsOnKept: 'f0000000-0000-4000-8000-000000000005',
};

const FORKS = {
  sportsFromTwin: 'b0000000-0000-4000-8000-000000000001',
  languagesRetiredFromTwin: 'b0000000-0000-4000-8000-000000000002',
  seasonFromKept: 'b0000000-0000-4000-8000-000000000003',
  seasonFromTwin: 'b0000000-0000-4000-8000-000000000004',
};

const PROMPTS = {
  pendingOnTwin: 'c0000000-0000-4000-8000-000000000001',
  pendingOnTwinForForker: 'c0000000-0000-4000-8000-000000000002',
  writtenOnTwin: 'c0000000-0000-4000-8000-000000000003',
};

/** The curated keys the scenario touches. */
const KEYS = [
  'pronouns',
  'morning_person_or_night_owl',
  'relationship_status',
  'birth_city',
  'sports_followed',
  'spoken_languages',
  'favorite_season',
  'cat_or_dog_person',
  'volunteering',
] as const;

type Key = (typeof KEYS)[number];

interface Pair {
  kept: string;
  twin: string;
}

describeWithDatabase(`Life-details duplicate retirement (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  const query = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    scratch.dataSource.query(sql, params);

  /** One half of the migration, the way dbmate runs it: the whole thing, in one transaction. */
  async function run(half: 'up' | 'down', before = ''): Promise<void> {
    const runner = scratch.dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      if (before.length > 0) {
        await runner.query(before);
      }

      await runner.query(migrationHalf(half));
      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();

      throw err;
    } finally {
      await runner.release();
    }
  }

  /** Every text more than one active shared row carries. */
  async function activeSharedDuplicates(): Promise<Array<{ text: string; rows: number }>> {
    return query(
      `SELECT lower(btrim(question_text)) AS text, count(*)::int AS rows
         FROM ci.questions
        WHERE is_active AND is_private_to IS NULL
        GROUP BY 1
       HAVING count(*) > 1
        ORDER BY 1`,
    );
  }

  /** A curated key's keyed shared row, and its unkeyed shared twin, active or not. */
  async function pairFor(key: Key): Promise<Pair> {
    const rows = await query<Pair>(
      `SELECT k.question_id::text AS kept, t.question_id::text AS twin
         FROM ci.questions k
         JOIN ci.questions t
           ON lower(btrim(t.question_text)) = lower(btrim(k.question_text))
          AND t.question_id <> k.question_id
          AND t.is_private_to IS NULL
          AND t.question_key IS NULL
        WHERE k.question_key = $1
          AND k.is_private_to IS NULL`,
      [key],
    );

    if (rows.length !== 1) {
      throw new Error(`expected exactly one unkeyed twin of ${key}, found ${rows.length}`);
    }

    return rows[0];
  }

  /**
   * What the Self page's Life details grid gets for one user: the same request
   * lifeDetails.ts builds (`keys=…&status=active&answered=all`), answered by
   * the real service. Only the DataSource is exercised; the repository and the
   * event bus are never touched by findCatalogue.
   */
  async function lifeDetailsFor(
    userId: string,
    keys: readonly Key[],
  ): Promise<Record<string, { id: string; answer: string | null }>> {
    const service = new QuestionService(scratch.dataSource, {} as never, {} as never);
    const page = await service.findCatalogue(
      { userId } as ServiceContext,
      questionCatalogueQuerySchema.parse({
        keys: keys.join(','),
        status: 'active',
        answered: 'all',
        limit: 100,
      }),
    );

    return Object.fromEntries(
      page.data.map((row) => [row.key, { id: row.id, answer: row.answer?.text ?? null }]),
    );
  }

  /** Everything the migration may touch, minus the `updated_at` stamps it legitimately bumps. */
  async function snapshot(): Promise<unknown[]> {
    return query(
      `SELECT 'question' AS kind, question_id::text AS id, question_key AS a, is_active::text AS b,
              forked_from_question_id::text AS c, is_private_to::text AS d
         FROM ci.questions
        WHERE is_private_to IS NOT NULL
           OR lower(btrim(question_text)) IN (
                SELECT lower(btrim(question_text)) FROM ci.questions WHERE question_key IS NOT NULL)
       UNION ALL
       SELECT 'answer', answer_id::text, question_id::text, answer_text,
              answer_source || ' @ ' || answered_at::text, user_id::text
         FROM ci.answers
       UNION ALL
       SELECT 'feed', feed_queue_id::text, question_id::text, item_type,
              enqueued_at::text || ' ' || metadata::text, user_id::text
         FROM ci.feed_queue
       UNION ALL
       SELECT 'prompt', context_prompt_id::text, status, source::text, NULL, user_id::text
         FROM ci.context_prompts
        ORDER BY 1, 2`,
    );
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'life-details duplicate retirement' });
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  describe('a fresh install (every migration, from empty)', () => {
    it('ends with no two active shared questions sharing a text', async () => {
      expect(await activeSharedDuplicates()).toEqual([]);
    });

    it('keeps every keyed row active, and retires the 26 pinned-id twins', async () => {
      const [counts] = await query<{ kept_active: number; twins: number; twins_active: number }>(
        `SELECT count(DISTINCT k.question_id)::int AS kept_active,
                count(t.question_id)::int AS twins,
                count(t.question_id) FILTER (WHERE t.is_active)::int AS twins_active
           FROM ci.questions k
           LEFT JOIN ci.questions t
             ON lower(btrim(t.question_text)) = lower(btrim(k.question_text))
            AND t.question_id <> k.question_id
            AND t.is_private_to IS NULL
          WHERE k.question_key IS NOT NULL AND k.is_private_to IS NULL AND k.is_active`,
      );

      // 29 curated keys, 26 of them seeded twice. Height, weight and sexual
      // orientation were already single rows under their pinned ids.
      expect(counts).toEqual({ kept_active: 29, twins: 26, twins_active: 0 });
    });

    it('records each retirement, and moves nothing, because a fresh install has nothing to move', async () => {
      const rows = await query<{ change: string; n: number }>(
        `SELECT change, count(*)::int AS n FROM ci.question_duplicate_retirements GROUP BY 1 ORDER BY 1`,
      );

      expect(rows).toEqual([{ change: 'twin_retired', n: 26 }]);
    });
  });

  describe('an appliance that was used while the duplicates were live', () => {
    const pairs = {} as Record<Key, Pair>;
    let before: unknown[];
    let questionCount: number;

    beforeAll(async () => {
      // Back to the state 20260824234643 left: 26 twins, live.
      await run('down');
      expect((await activeSharedDuplicates()).length).toBe(26);

      for (const key of KEYS) {
        pairs[key] = await pairFor(key);
      }

      await query(
        `INSERT INTO ci.users (id, email, name) VALUES
           ($1::uuid, 'one@example.test', 'One'),
           ($2::uuid, 'two@example.test', 'Two'),
           ($3::uuid, 'three@example.test', 'Three')`,
        [USERS.one, USERS.two, USERS.three],
      );

      const answer = (id: string, question: string, user: string, text: string, source: string, at: string) =>
        query(
          `INSERT INTO ci.answers (answer_id, question_id, user_id, answer_text, answer_source, answered_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)`,
          [id, question, user, text, source, at],
        );

      const feed = (id: string, question: string, user: string) =>
        query(
          `INSERT INTO ci.feed_queue (feed_queue_id, user_id, question_id, item_type, enqueued_at, metadata)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'question', '2026-09-20T10:00:00Z', '{"lastPresentedAt": "2026-09-21T10:00:00Z"}')`,
          [id, user, question],
        );

      // As QuestionService.forkSharedQuestion writes one: the origin's key comes across.
      const fork = (id: string, origin: string, owner: string, text: string, active: boolean) =>
        query(
          `INSERT INTO ci.questions
             (question_id, question_text, question_key, question_category, question_type, is_private_to,
              forked_from_question_id, is_active, is_seed_question, created_by_llm)
           SELECT $1::uuid, $4, o.question_key, o.question_category, o.question_type, $3::uuid, o.question_id,
                  $5, false, false
             FROM ci.questions o WHERE o.question_id = $2::uuid`,
          [id, origin, owner, text, active],
        );

      const prompt = (id: string, user: string, status: string, question: string) =>
        query(
          `INSERT INTO ci.context_prompts (context_prompt_id, user_id, status, selector, source)
           VALUES ($1::uuid, $2::uuid, $3, '{"type": "text", "prompt": "?"}',
                   jsonb_build_object('kind', 'question', 'id', $4::text, 'label', 'Interests & Culture: ?'))`,
          [id, user, status, question],
        );

      // One: typed pronouns on the Self page while it still wrote to the pinned ids.
      await answer(
        ANSWERS.pronounsOnTwin,
        pairs.pronouns.twin,
        USERS.one,
        'they/them',
        'user_input',
        '2026-08-24T23:00:00Z',
      );
      // One: inference asked both copies, and guessed the same thing twice.
      await answer(
        ANSWERS.chronotypeOnKept,
        pairs.morning_person_or_night_owl.kept,
        USERS.one,
        'Night owl',
        'inferred',
        '2026-08-21T10:00:00Z',
      );
      await answer(
        ANSWERS.chronotypeOnTwin,
        pairs.morning_person_or_night_owl.twin,
        USERS.one,
        'Night owl',
        'inferred',
        '2026-08-24T23:30:00Z',
      );
      // Two: typed on the twin in Reflections; inference later filled the kept row.
      await answer(
        ANSWERS.relationshipOnTwin,
        pairs.relationship_status.twin,
        USERS.two,
        'Married',
        'user_input',
        '2026-09-02T10:00:00Z',
      );
      await answer(
        ANSWERS.relationshipOnKept,
        pairs.relationship_status.kept,
        USERS.two,
        'In a relationship',
        'inferred',
        '2026-09-05T10:00:00Z',
      );
      // One: the season twin, answered by someone with no fork at all.
      await answer(
        ANSWERS.seasonOnTwin,
        pairs.favorite_season.twin,
        USERS.one,
        'Autumn',
        'user_input',
        '2026-09-03T10:00:00Z',
      );

      // One: queued on both copies of birth city. Three: queued on the twin alone.
      await feed(FEED.birthCityOnKept, pairs.birth_city.kept, USERS.one);
      await feed(FEED.birthCityOnTwin, pairs.birth_city.twin, USERS.one);
      await feed(FEED.birthCityOnTwinAlone, pairs.birth_city.twin, USERS.three);

      // Two: reworded the sports twin (and answered the reworded copy), but the
      // kept row stayed visible, so they also answered and were queued it.
      await fork(
        FORKS.sportsFromTwin,
        pairs.sports_followed.twin,
        USERS.two,
        'Which teams do you follow?',
        true,
      );
      await answer(
        ANSWERS.sportsOnFork,
        FORKS.sportsFromTwin,
        USERS.two,
        'Arsenal',
        'user_input',
        '2026-09-10T10:00:00Z',
      );
      await answer(
        ANSWERS.sportsOnKept,
        pairs.sports_followed.kept,
        USERS.two,
        'Football',
        'user_input',
        '2026-09-12T10:00:00Z',
      );
      await feed(FEED.sportsOnTwin, pairs.sports_followed.twin, USERS.two);
      await feed(FEED.sportsOnKept, pairs.sports_followed.kept, USERS.two);

      // Three: retired the languages twin, then inference answered the kept row.
      await fork(
        FORKS.languagesRetiredFromTwin,
        pairs.spoken_languages.twin,
        USERS.three,
        'What languages do you speak?',
        false,
      );
      await answer(
        ANSWERS.languagesOnKept,
        pairs.spoken_languages.kept,
        USERS.three,
        'English',
        'inferred',
        '2026-09-15T10:00:00Z',
      );

      // Three: reworded BOTH season copies, and still has an answer on the twin.
      await fork(
        FORKS.seasonFromKept,
        pairs.favorite_season.kept,
        USERS.three,
        'Which season do you like best?',
        true,
      );
      await fork(FORKS.seasonFromTwin, pairs.favorite_season.twin, USERS.three, 'Favourite season?', true);
      await answer(
        ANSWERS.seasonOnTwinByForker,
        pairs.favorite_season.twin,
        USERS.three,
        'Spring',
        'user_input',
        '2026-09-18T10:00:00Z',
      );

      // Context prompts generated for a twin: two still open, one already written.
      await prompt(PROMPTS.pendingOnTwin, USERS.one, 'pending', pairs.cat_or_dog_person.twin);
      await prompt(PROMPTS.pendingOnTwinForForker, USERS.three, 'pending', pairs.favorite_season.twin);
      await prompt(PROMPTS.writtenOnTwin, USERS.two, 'written', pairs.volunteering.twin);

      before = await snapshot();
      [{ n: questionCount }] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ci.questions`);

      await run('up');
    });

    it('leaves no two active shared questions sharing a text', async () => {
      expect(await activeSharedDuplicates()).toEqual([]);
    });

    it('retires every twin and keeps every kept row, deleting no question', async () => {
      for (const { kept, twin } of Object.values(pairs)) {
        const rows = await query<{ id: string; is_active: boolean }>(
          `SELECT question_id::text AS id, is_active FROM ci.questions WHERE question_id = ANY($1::uuid[])`,
          [[kept, twin]],
        );

        expect(Object.fromEntries(rows.map((row) => [row.id, row.is_active]))).toEqual({
          [kept]: true,
          [twin]: false,
        });
      }

      const [{ n }] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ci.questions`);

      expect(n).toBe(questionCount);
    });

    it('moves each answer to the row that stands for the question for its user, rewriting nothing else', async () => {
      const rows = await query<{ id: string; question_id: string; text: string; source: string; at: string }>(
        `SELECT answer_id::text AS id, question_id::text, answer_text AS text, answer_source AS source,
                to_char(answered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS at
           FROM ci.answers ORDER BY answer_id`,
      );

      expect(rows).toEqual([
        // A twin's answer goes to the kept row...
        {
          id: ANSWERS.pronounsOnTwin,
          question_id: pairs.pronouns.kept,
          text: 'they/them',
          source: 'user_input',
          at: '2026-08-24T23:00',
        },
        {
          id: ANSWERS.chronotypeOnKept,
          question_id: pairs.morning_person_or_night_owl.kept,
          text: 'Night owl',
          source: 'inferred',
          at: '2026-08-21T10:00',
        },
        {
          id: ANSWERS.chronotypeOnTwin,
          question_id: pairs.morning_person_or_night_owl.kept,
          text: 'Night owl',
          source: 'inferred',
          at: '2026-08-24T23:30',
        },
        // ...both survive where both copies were answered...
        {
          id: ANSWERS.relationshipOnTwin,
          question_id: pairs.relationship_status.kept,
          text: 'Married',
          source: 'user_input',
          at: '2026-09-02T10:00',
        },
        {
          id: ANSWERS.relationshipOnKept,
          question_id: pairs.relationship_status.kept,
          text: 'In a relationship',
          source: 'inferred',
          at: '2026-09-05T10:00',
        },
        // ...a re-pointed fork owner's kept-row answer is adopted onto the fork,
        // as adoptOwnHistory would, and the fork's own answer stays put...
        {
          id: ANSWERS.sportsOnFork,
          question_id: FORKS.sportsFromTwin,
          text: 'Arsenal',
          source: 'user_input',
          at: '2026-09-10T10:00',
        },
        {
          id: ANSWERS.sportsOnKept,
          question_id: FORKS.sportsFromTwin,
          text: 'Football',
          source: 'user_input',
          at: '2026-09-12T10:00',
        },
        // ...even onto a fork the owner retired: that is where forkSharedQuestion puts it too...
        {
          id: ANSWERS.languagesOnKept,
          question_id: FORKS.languagesRetiredFromTwin,
          text: 'English',
          source: 'inferred',
          at: '2026-09-15T10:00',
        },
        {
          id: ANSWERS.seasonOnTwin,
          question_id: pairs.favorite_season.kept,
          text: 'Autumn',
          source: 'user_input',
          at: '2026-09-03T10:00',
        },
        // ...and a user who forked the kept row gets the twin's answer on that fork, not on a row hidden from them.
        {
          id: ANSWERS.seasonOnTwinByForker,
          question_id: FORKS.seasonFromKept,
          text: 'Spring',
          source: 'user_input',
          at: '2026-09-18T10:00',
        },
      ]);
    });

    it('shows the Self page every moved answer, through the real catalogue query', async () => {
      expect(
        await lifeDetailsFor(USERS.one, ['pronouns', 'morning_person_or_night_owl', 'favorite_season']),
      ).toEqual({
        pronouns: { id: pairs.pronouns.kept, answer: 'they/them' },
        morning_person_or_night_owl: { id: pairs.morning_person_or_night_owl.kept, answer: 'Night owl' },
        favorite_season: { id: pairs.favorite_season.kept, answer: 'Autumn' },
      });

      // Latest answer wins, as it always has; the typed one is history on the same question.
      expect(await lifeDetailsFor(USERS.two, ['relationship_status', 'sports_followed'])).toEqual({
        relationship_status: { id: pairs.relationship_status.kept, answer: 'In a relationship' },
        sports_followed: { id: FORKS.sportsFromTwin, answer: 'Football' },
      });

      // Three retired languages, so the grid hides it, as it would had they retired the kept row.
      // Their season row is their own fork of the kept row, carrying the answer from the twin.
      expect(await lifeDetailsFor(USERS.three, ['spoken_languages', 'favorite_season'])).toEqual({
        favorite_season: { id: FORKS.seasonFromKept, answer: 'Spring' },
      });
    });

    it('moves a queued feed item to the kept row, and drops only the ones a fork or a duplicate supersedes', async () => {
      const rows = await query<{ id: string; question_id: string }>(
        `SELECT feed_queue_id::text AS id, question_id::text FROM ci.feed_queue ORDER BY 1`,
      );

      expect(rows).toEqual([
        { id: FEED.birthCityOnKept, question_id: pairs.birth_city.kept },
        { id: FEED.birthCityOnTwinAlone, question_id: pairs.birth_city.kept },
      ]);
    });

    it('re-points a fork of a twin at the kept row, key included, unless its owner already forked that', async () => {
      const rows = await query<{ id: string; origin: string; key: string | null; is_active: boolean }>(
        `SELECT question_id::text AS id, forked_from_question_id::text AS origin, question_key AS key, is_active
           FROM ci.questions WHERE question_id = ANY($1::uuid[]) ORDER BY 1`,
        [Object.values(FORKS)],
      );

      expect(rows).toEqual([
        {
          id: FORKS.sportsFromTwin,
          origin: pairs.sports_followed.kept,
          key: 'sports_followed',
          is_active: true,
        },
        {
          id: FORKS.languagesRetiredFromTwin,
          origin: pairs.spoken_languages.kept,
          key: 'spoken_languages',
          is_active: false,
        },
        {
          id: FORKS.seasonFromKept,
          origin: pairs.favorite_season.kept,
          key: 'favorite_season',
          is_active: true,
        },
        { id: FORKS.seasonFromTwin, origin: pairs.favorite_season.twin, key: null, is_active: true },
      ]);
    });

    it('re-points an open context prompt for a twin, and leaves a written one as the record it is', async () => {
      const rows = await query<{ id: string; points_at: string }>(
        `SELECT context_prompt_id::text AS id, source ->> 'id' AS points_at FROM ci.context_prompts ORDER BY 1`,
      );

      expect(rows).toEqual([
        { id: PROMPTS.pendingOnTwin, points_at: pairs.cat_or_dog_person.kept },
        { id: PROMPTS.pendingOnTwinForForker, points_at: FORKS.seasonFromKept },
        { id: PROMPTS.writtenOnTwin, points_at: pairs.volunteering.twin },
      ]);
    });

    it('records every change it made in the ledger', async () => {
      const rows = await query<{ change: string; n: number }>(
        `SELECT change, count(*)::int AS n FROM ci.question_duplicate_retirements GROUP BY 1 ORDER BY 1`,
      );

      expect(rows).toEqual([
        { change: 'answer_moved', n: 7 },
        { change: 'context_prompt_repointed', n: 2 },
        { change: 'feed_item_dropped', n: 3 },
        { change: 'feed_item_moved', n: 1 },
        { change: 'fork_repointed', n: 2 },
        { change: 'twin_retired', n: 26 },
      ]);
    });

    it('is idempotent: a second run changes nothing', async () => {
      const after = await snapshot();

      await run('up');

      expect(await snapshot()).toEqual(after);
    });

    it('down puts every answer, feed item, fork, prompt and twin back exactly where it was', async () => {
      await run('down');

      expect(await snapshot()).toEqual(before);

      const [{ ledger }] = await query<{ ledger: string | null }>(
        `SELECT to_regclass('ci.question_duplicate_retirements')::text AS ledger`,
      );

      expect(ledger).toBeNull();

      await run('up');

      expect(await activeSharedDuplicates()).toEqual([]);
    });

    it('refuses to report success while a keyed question still has an active twin it cannot retire', async () => {
      // A second KEYED shared row carrying a curated text. It is not the
      // unkeyed shape the up path retires, so only the closing assertion can
      // catch it.
      const probe = `INSERT INTO ci.questions (question_text, question_key, is_seed_question, created_by_llm)
                     SELECT question_text, 'duplicate_probe', true, false
                       FROM ci.questions WHERE question_key = 'blood_type' AND is_private_to IS NULL;`;

      await expect(run('up', probe)).rejects.toThrow(/blood_type/);

      const [{ n }] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ci.questions WHERE question_key = 'duplicate_probe'`,
      );

      expect(n).toBe(0);
    });
  });
});
