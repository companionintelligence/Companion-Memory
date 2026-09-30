import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { Events } from '@ci/domains/events';
import { QuestionService } from '@ci/domains/intelligence';
import { LLM_BACKGROUND_QUEUE } from '@ci/domains/llm';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { INFERENCE_ATTEMPT_COOLDOWN_HOURS, SmartRotationListener } from '../SmartRotationListener';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANSWER-INFERENCE SELECTION, RANKED BY A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The unit suite can only assert the SHAPE of the selection query — a mocked
 * DataSource returns whatever the test handed it, so it cannot tell an ORDER BY
 * that ranks correctly from one that does not. This suite executes the real
 * query against the real schema and reads the row Postgres picked.
 *
 * What it exists to catch: the selection used to be `ORDER BY q.created_at ASC`
 * with no notion of what had already been tried, so the single oldest
 * unanswered question was re-selected on every 20-minute tick. Because a
 * timed-out or gate-discarded inference writes nothing to ci.answers, nothing
 * ever removed it. Measured on the reference appliance before the fix: 46 of 46
 * dispatches over 17 hours went to one question id, ci.answers stayed empty,
 * and 1,278 other eligible questions were never offered to the model.
 *
 * The first two tests are READ-ONLY: the attempt history they assert against
 * is whatever pg-boss already recorded on the machine running the test. The
 * rotation-order tests below write a small catalogue of their own, inside one
 * transaction that is always rolled back.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[smart-rotation/SmartRotationListener.answerInfer] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** The listener with only the three collaborators `answer_infer` touches. */
function buildListener(dataSource: DataSource, send: jest.Mock): SmartRotationListener {
  const logger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as never;

  return new SmartRotationListener(
    {} as never,
    {} as never,
    { send } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dataSource,
    logger,
  );
}

describeWithDatabase(`SmartRotationListener answer_infer selection (${availability.target})`, () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('the selection query agrees with the live schema — ci.questions, ci.answers and pgboss both sides', async () => {
    const send = jest.fn();
    const listener = buildListener(dataSource, send);

    // Executing it is the assertion: Postgres validates every column, join and
    // cast — including `pgboss.job` / `pgboss.archive`, which no other
    // smart-rotation query touches, and the five bound parameters, whose types
    // it has to deduce as {uuid, text, text, integer, text} without a conflict.
    //
    // A random owner is NOT a no-op here: the reflection catalogue is shared
    // (`is_private_to IS NULL`), so an owner with no rows of their own still
    // sees every seed question, has answered none of them, and gets the first
    // one dispatched. That is the correct answer for a brand-new owner — they
    // have no attempt history, so the least-recently-attempted order falls back
    // to oldest-first.
    await expect(
      listener.handleWork({ userId: randomUUID(), workType: 'answer_infer' }),
    ).resolves.toBeUndefined();

    for (const [eventName, payload] of send.mock.calls as [string, { questionId: string }][]) {
      expect(eventName).toBe(Events.INFER_QUESTION_ANSWER);
      expect(payload.questionId).toEqual(expect.any(String));
    }
  });

  it('does not re-select a question inference was already dispatched for', async () => {
    type AttemptRow = { owner_id: string; question_id: string; attempts: string };

    // Whatever this appliance has actually dispatched. Driven off pg-boss
    // rather than a fixture so the suite stays read-only, and so it asserts
    // against the same history the listener reads.
    const attempted = (await dataSource.query(
      `
      SELECT
        dispatched.data->>'ownerId' AS owner_id,
        dispatched.data->>'questionId' AS question_id,
        COUNT(*)::text AS attempts
      FROM (
        SELECT data FROM pgboss.job WHERE name = 'llm-background' AND data->>'name' = $1
        UNION ALL
        SELECT data FROM pgboss.archive WHERE name = 'llm-background' AND data->>'name' = $1
      ) dispatched
      WHERE dispatched.data->>'ownerId' IS NOT NULL
      GROUP BY 1, 2
      ORDER BY COUNT(*) DESC;
      `,
      [Events.INFER_QUESTION_ANSWER],
    )) as AttemptRow[];

    if (attempted.length === 0) {
      // Nothing has been dispatched on this machine inside pg-boss's retention
      // window, so there is no history for the ORDER BY to rank against and
      // this assertion would be vacuous. The schema test above still ran.
      console.warn(
        '[smart-rotation/SmartRotationListener.answerInfer] no infer.question.answer history in pg-boss — ' +
          'ranking assertion skipped',
      );

      return;
    }

    const ownerId = attempted[0].owner_id;
    const alreadyTried = new Set(
      attempted.filter((row) => row.owner_id === ownerId).map((row) => row.question_id),
    );

    const send = jest.fn();
    const listener = buildListener(dataSource, send);

    await listener.handleWork({ userId: ownerId, workType: 'answer_infer' });

    // Either the owner has nothing left outside the cooldown (a legitimate
    // no-op), or what came back is a question this appliance has not just
    // spent a slot on. What must never happen again is the third case: the
    // same question handed back while untried ones wait.
    if (send.mock.calls.length === 0) {
      return;
    }

    const [, payload] = send.mock.calls[0] as [string, { questionId: string }];

    expect(alreadyTried.has(payload.questionId)).toBe(false);
  });

  // ═══ THE ROTATION ORDER ═══
  //
  // Both selectors take untried questions in the catalogue's rotation order
  // (domains/intelligence/questionOrder.ts): tier, then batch age, then a
  // round-robin across categories in the order the seed files list them. Before
  // it, the last tiebreak was `q.question_id` — and the seeded catalogue carries
  // random v4 ids under one shared created_at, so every appliance asked it in a
  // different order. These tests run both selectors over a small catalogue laid
  // out like the real one, answer each pick, and ask again.
  //
  // What they write — the questions, an owner, the answers, and an UPDATE that
  // hides the real catalogue so it cannot compete with the fixture — happens in
  // one transaction that is always rolled back. Both selectors are handed a
  // DataSource whose `query` forwards to that transaction's runner.

  /** One question of the fixture catalogue. */
  interface FixtureQuestion {
    text: string;
    category: string;
    tier: 'factual' | 'preference' | 'narrative';
    /** Index into {@link BATCH_CREATED_AT}: 0 is the older seed batch. */
    batch: 0 | 1;
    seedPosition: number | null;
    handEntry?: boolean;
  }

  const BATCH_CREATED_AT = ['2001-01-01T00:00:00Z', '2001-01-02T00:00:00Z'];

  // Batch 0 is written the way the seed files are: category by category, facts
  // first, with a hand-entry question at the head of the first category, as the
  // real Health & Body block has. Batch 1 is newer and no seed wrote it.
  const CATALOGUE: FixtureQuestion[] = [
    {
      text: 'Body: hand-entry',
      category: 'Health & Body',
      tier: 'factual',
      batch: 0,
      seedPosition: 1,
      handEntry: true,
    },
    { text: 'Body: fact 1', category: 'Health & Body', tier: 'factual', batch: 0, seedPosition: 2 },
    { text: 'Body: fact 2', category: 'Health & Body', tier: 'factual', batch: 0, seedPosition: 3 },
    { text: 'Body: taste 1', category: 'Health & Body', tier: 'preference', batch: 0, seedPosition: 4 },
    { text: 'Travel: fact 1', category: 'Places & Travel', tier: 'factual', batch: 0, seedPosition: 5 },
    { text: 'Travel: fact 2', category: 'Places & Travel', tier: 'factual', batch: 0, seedPosition: 6 },
    { text: 'Travel: fact 3', category: 'Places & Travel', tier: 'factual', batch: 0, seedPosition: 7 },
    { text: 'Travel: taste 1', category: 'Places & Travel', tier: 'preference', batch: 0, seedPosition: 8 },
    { text: 'Work: fact 1', category: 'Work & Money', tier: 'factual', batch: 0, seedPosition: 9 },
    { text: 'Work: story 1', category: 'Work & Money', tier: 'narrative', batch: 0, seedPosition: 10 },
    {
      text: 'Body, unseeded: zebra',
      category: 'Health & Body',
      tier: 'factual',
      batch: 1,
      seedPosition: null,
    },
    {
      text: 'Travel, unseeded: apple',
      category: 'Places & Travel',
      tier: 'factual',
      batch: 1,
      seedPosition: null,
    },
    {
      text: 'Body, unseeded: mango',
      category: 'Health & Body',
      tier: 'factual',
      batch: 1,
      seedPosition: null,
    },
  ];

  // What a fresh owner is asked, in order, by either selector.
  const ROTATION = [
    // Facts, older batch. Round 1 takes each category's first question, the
    // categories in the order they are written. The hand-entry row never takes
    // a turn, so Body still goes first. And Body's second fact waits for Travel
    // and Work although Body's first is answered by then: ranked over what was
    // left instead of the whole catalogue, it would have become round 1 itself
    // and Body would have drained before anything else was asked.
    'Body: fact 1',
    'Travel: fact 1',
    'Work: fact 1',
    // Rounds 2 and 3. Work has no second fact.
    'Body: fact 2',
    'Travel: fact 2',
    'Travel: fact 3',
    // Facts, newer batch. No written order, so by text within a category and
    // by category name across them.
    'Body, unseeded: mango',
    'Travel, unseeded: apple',
    'Body, unseeded: zebra',
    // Every fact before any preference, whichever batch the fact is in. The
    // listener's old order had no tier rank at all.
    'Body: taste 1',
    'Travel: taste 1',
    'Work: story 1',
  ];

  /**
   * Runs both selectors to exhaustion over the fixture, with ids laid out so
   * that sorting by id gives `layout` order, and returns the texts asked in
   * turn. Two layouts of one catalogue are two appliances in miniature.
   */
  async function rotation(layout: 'written' | 'reversed'): Promise<string[]> {
    const runner = dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      const forwarding = {
        query: (sql: string, params?: unknown[]) => runner.query(sql, params),
      } as unknown as DataSource;
      const ownerId = randomUUID();
      const idPrefix = randomUUID().slice(0, 24);
      const textById = new Map<string, string>();

      await runner.query(`INSERT INTO ci.users (id, email, name, onboarded) VALUES ($1, $2, $3, true)`, [
        ownerId,
        `rotation-order.${ownerId}@example.test`,
        'rotation order',
      ]);
      await runner.query(`UPDATE ci.questions SET is_active = false WHERE is_active`);

      for (const [index, question] of CATALOGUE.entries()) {
        const rank = layout === 'written' ? index : CATALOGUE.length - index;
        const id = `${idPrefix}${rank.toString(16).padStart(12, '0')}`;

        textById.set(id, question.text);
        await runner.query(
          `INSERT INTO ci.questions
             (question_id, question_text, question_category, question_type, answer_tier, evidence_class,
              seed_position, is_seed_question, created_by_llm, is_active, created_at)
           VALUES ($1, $2, $3, 'open_ended', $4, $5, $6, $7, false, true, $8)`,
          [
            id,
            question.text,
            question.category,
            question.tier,
            question.handEntry ? 'hand_entry' : 'traceable',
            question.seedPosition,
            question.seedPosition != null,
            BATCH_CREATED_AT[question.batch],
          ],
        );
      }

      const send = jest.fn();
      const listener = buildListener(forwarding, send);
      const questionService = new QuestionService(forwarding, {} as never, { send: jest.fn() } as never);
      const asked: string[] = [];

      for (let step = 0; step <= CATALOGUE.length; step++) {
        send.mockClear();
        await listener.handleWork({ userId: ownerId, workType: 'answer_infer' });

        const fromListener =
          (send.mock.calls[0]?.[1] as { questionId: string } | undefined)?.questionId ?? null;
        const byUser = await questionService.findUnansweredByUserId({
          queue: LLM_BACKGROUND_QUEUE,
          eventName: Events.INFER_QUESTION_ANSWER,
          cooldownHours: INFERENCE_ATTEMPT_COOLDOWN_HOURS,
        });

        // One definition of order, so one answer at every step.
        expect(byUser.get(ownerId)?.[0] ?? null).toBe(fromListener);

        if (fromListener == null) {
          break;
        }

        asked.push(textById.get(fromListener) ?? `not a fixture question: ${fromListener}`);
        await runner.query(
          `INSERT INTO ci.answers (question_id, user_id, answer_text, answer_method)
           VALUES ($1, $2, 'rolled back', 'inferred')`,
          [fromListener, ownerId],
        );
      }

      return asked;
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it('asks tier by tier, oldest batch first, round-robin across categories in written order', async () => {
    expect(await rotation('written')).toEqual(ROTATION);
  });

  it('asks in the same order when the ids sort the other way — as they do on another appliance', async () => {
    expect(await rotation('reversed')).toEqual(ROTATION);
  });
});
