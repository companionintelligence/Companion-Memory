import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import { type ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { Events } from '@ci/domains/events';
import { QuestionService } from '@ci/domains/intelligence';
import { LLM_BACKGROUND_QUEUE } from '@ci/domains/llm';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { AnswerInferenceListener } from '../AnswerInferenceListener';
import { INFERENCE_ATTEMPT_COOLDOWN_HOURS, SmartRotationListener } from '../SmartRotationListener';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EXECUTION-TIME GATE, READING A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `AnswerInferenceListener.test.ts` mocks `QuestionService.findInferenceStanding`,
 * so it can say what the listener DOES with each answer and nothing about whether
 * the answer is RIGHT. That is a SQL question — the `is_active` and
 * `evidence_class` tests, the visibility rule, and the shared
 * `excludeForkedOriginsSql` fork filter, bound to two parameters that each have
 * to type-check as uuid — and a mocked `query` returns whatever it is handed.
 *
 * What this suite pins:
 *
 *   1. The three facts, for every state a queued question can be in, including
 *      the two a fork makes easy to get wrong: a fork the owner has since
 *      RETIRED still hides its origin, and somebody ELSE's fork never does.
 *   2. The gate agrees with the selectors. A job is only ever queued for a
 *      question both selectors pick, so "the listener runs the model" has to
 *      mean exactly "a selector would still queue it". Three copies of those
 *      predicates exist — two inline in the selectors, one in the gate — and this
 *      is what notices when one of them moves.
 *   3. The failure itself, in order: queued while eligible, changed, then run.
 *
 * Everything runs in one transaction that is always rolled back, including a
 * `UPDATE` that deactivates the real catalogue so the fixtures are what the
 * selectors choose from. Nothing is committed.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[smart-rotation/AnswerInferenceListener.executionGate] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const ATTEMPT_HISTORY = {
  queue: LLM_BACKGROUND_QUEUE,
  eventName: Events.INFER_QUESTION_ANSWER,
  cooldownHours: INFERENCE_ATTEMPT_COOLDOWN_HOURS,
} as const;

type Standing = Awaited<ReturnType<QuestionService['findInferenceStanding']>>;
type Payload = Parameters<AnswerInferenceListener['inferQuestionAnswer']>[0];

/** What a question the selectors would queue reads as. */
const TRACEABLE: NonNullable<Standing> = {
  isActive: true,
  evidenceClass: 'traceable',
  forkedByCaller: false,
};

describeWithDatabase(`AnswerInferenceListener execution-time gate (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let questionService: QuestionService;
  let listener: AnswerInferenceListener;
  let selectorListener: SmartRotationListener;
  let ownerId: string;
  let otherId: string;

  /** Sent by SmartRotationListener's selector, read back by `drain`. */
  const sent: Array<{ questionId: string }> = [];
  /** How many times the model was reached. A plain counter: no mock to be reset. */
  let modelCalls = 0;

  const ids = {
    active: randomUUID(),
    inactive: randomUUID(),
    handEntry: randomUUID(),
    forkedOrigin: randomUUID(),
    ownFork: randomUUID(),
    retiredForkOrigin: randomUUID(),
    retiredFork: randomUUID(),
    forkedByOtherOnly: randomUUID(),
    othersFork: randomUUID(),
    ownPrivate: randomUUID(),
    othersPrivate: randomUUID(),
    /** No row at all. */
    missing: randomUUID(),
  };

  const asOwner = () => ({ userId: ownerId }) as ServiceContext;

  async function insertQuestion(question: {
    id: string;
    label: string;
    active?: boolean;
    evidenceClass?: 'traceable' | 'hand_entry';
    privateTo?: string;
    forkedFrom?: string;
  }) {
    await runner.query(
      `INSERT INTO ci.questions
         (question_id, question_text, question_category, question_type, answer_tier, evidence_class,
          is_active, is_private_to, forked_from_question_id)
       VALUES ($1, $2, 'Execution gate', 'open_ended', 'factual', $3, $4, $5, $6)`,
      [
        question.id,
        `Execution gate fixture: ${question.label}`,
        question.evidenceClass ?? 'traceable',
        question.active ?? true,
        question.privateTo ?? null,
        question.forkedFrom ?? null,
      ],
    );
  }

  /** Runs `body`, then undoes whatever it wrote. One test's changes never reach the next. */
  async function inSavepoint<T>(body: () => Promise<T>): Promise<T> {
    await runner.query('SAVEPOINT gate_test');

    try {
      return await body();
    } finally {
      await runner.query('ROLLBACK TO SAVEPOINT gate_test');
      await runner.query('RELEASE SAVEPOINT gate_test');
    }
  }

  /** Whether a job for this question, run now, reaches the model. */
  async function jobRunsModel(questionId: string): Promise<boolean> {
    const before = modelCalls;

    await listener.inferQuestionAnswer({ ownerId, questionId } as Payload);

    return modelCalls > before;
  }

  /**
   * Asks a selector for a question, "answers" it, and asks again, until it has
   * nothing left — which leaves exactly the questions it would ever queue.
   */
  async function drain(pick: () => Promise<string | null>): Promise<Set<string>> {
    return inSavepoint(async () => {
      const queued = new Set<string>();

      for (let step = 0; step <= Object.keys(ids).length; step++) {
        const next = await pick();

        if (next == null) {
          break;
        }

        queued.add(next);
        await runner.query(
          `INSERT INTO ci.answers (question_id, user_id, answer_text, answer_method)
           VALUES ($1, $2, 'rolled back', 'inferred')`,
          [next, ownerId],
        );
      }

      return queued;
    });
  }

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

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    // Everything below reaches only `dataSource.query`, and every statement has
    // to run on the transaction's own connection or it would not see the fixtures.
    const forwarding = {
      query: (sql: string, params?: unknown[]) => runner.query(sql, params),
    } as unknown as DataSource;
    const logger = { setContext() {}, log() {}, warn() {}, error() {}, debug() {} } as never;

    questionService = new QuestionService(forwarding, {} as never, { send: jest.fn() } as never);

    // The REAL gate over real rows. What is stubbed is everything the gate is not:
    // the plain read that precedes it, and all of the retrieval and model work
    // behind it, which is reduced to a counter of how often it was reached.
    listener = new AnswerInferenceListener(
      { findByQuestionId: async () => null, findByIds: async () => [], findAll: async () => [] } as never,
      {
        findById: async (_context: unknown, id: string) => ({ id, text: `Question ${id}?` }),
        findInferenceStanding: (context: ServiceContext, id: string) =>
          questionService.findInferenceStanding(context, id),
      } as never,
      { search: async () => [] } as never,
      { recall: async () => ({ block: '', resultCount: 0, lines: [] }) } as never,
      { decideAction: async () => 'auto' } as never,
      {
        chat: async () => {
          modelCalls += 1;

          // Nothing parseable: reaching the model is all this suite observes.
          return { message: { content: '' } };
        },
      } as never,
      logger,
    );

    selectorListener = new SmartRotationListener(
      {} as never,
      {} as never,
      { send: async (_event: string, payload: { questionId: string }) => sent.push(payload) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      forwarding,
      logger,
    );

    const query = (sql: string, params?: unknown[]) => runner.query(sql, params);

    ownerId = await createSyntheticTestUser(query, 'ExecutionGateOwner');
    otherId = await createSyntheticTestUser(query, 'ExecutionGateOther');

    // Out of the way: both selectors take whatever they are offered first, so the
    // real catalogue would crowd the fixtures out. Rolled back with the rest.
    await runner.query(`UPDATE ci.questions SET is_active = false WHERE is_active`);

    await insertQuestion({ id: ids.active, label: 'active' });
    await insertQuestion({ id: ids.inactive, label: 'retired', active: false });
    await insertQuestion({ id: ids.handEntry, label: 'hand entry', evidenceClass: 'hand_entry' });

    // The owner forked this one, so the fork stands in for it and it is hidden.
    await insertQuestion({ id: ids.forkedOrigin, label: 'forked origin' });
    await insertQuestion({
      id: ids.ownFork,
      label: 'the owner’s fork',
      privateTo: ownerId,
      forkedFrom: ids.forkedOrigin,
    });

    // A fork the owner then retired still hides its origin — the case
    // `QuestionService.forkedOriginIds` is written around.
    await insertQuestion({ id: ids.retiredForkOrigin, label: 'origin of a retired fork' });
    await insertQuestion({
      id: ids.retiredFork,
      label: 'a retired fork',
      active: false,
      privateTo: ownerId,
      forkedFrom: ids.retiredForkOrigin,
    });

    // Somebody else's fork is theirs: the owner still sees, and is asked, the origin.
    await insertQuestion({ id: ids.forkedByOtherOnly, label: 'forked by somebody else' });
    await insertQuestion({
      id: ids.othersFork,
      label: 'somebody else’s fork',
      privateTo: otherId,
      forkedFrom: ids.forkedByOtherOnly,
    });

    await insertQuestion({ id: ids.ownPrivate, label: 'the owner’s own', privateTo: ownerId });
    await insertQuestion({ id: ids.othersPrivate, label: 'somebody else’s own', privateTo: otherId });
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    await runner?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('reads the three facts the selectors filter on, for every state a queued question can be in', async () => {
    const standings: Record<string, Standing> = {};

    for (const [name, id] of Object.entries(ids)) {
      standings[name] = await questionService.findInferenceStanding(asOwner(), id);
    }

    expect(standings).toEqual({
      active: TRACEABLE,
      inactive: { ...TRACEABLE, isActive: false },
      handEntry: { ...TRACEABLE, evidenceClass: 'hand_entry' },
      forkedOrigin: { ...TRACEABLE, forkedByCaller: true },
      ownFork: TRACEABLE,
      retiredForkOrigin: { ...TRACEABLE, forkedByCaller: true },
      retiredFork: { ...TRACEABLE, isActive: false },
      forkedByOtherOnly: TRACEABLE,
      // Not the owner's to see at all.
      othersFork: null,
      ownPrivate: TRACEABLE,
      othersPrivate: null,
      missing: null,
    });
  });

  it('answers for a system caller without binding the symbol — shared rows only, nothing forked', async () => {
    const system = { userId: SYSTEM_USER } as ServiceContext;

    // The owner's fork is the owner's: to nobody else is the origin replaced.
    expect(await questionService.findInferenceStanding(system, ids.forkedOrigin)).toEqual(TRACEABLE);
    expect(await questionService.findInferenceStanding(system, ids.handEntry)).toEqual({
      ...TRACEABLE,
      evidenceClass: 'hand_entry',
    });
    expect(await questionService.findInferenceStanding(system, ids.ownPrivate)).toBeNull();
  });

  it('runs the model for exactly the questions a selector would still queue', async () => {
    const byUser = await drain(
      async () => (await questionService.findUnansweredByUserId(ATTEMPT_HISTORY)).get(ownerId)?.[0] ?? null,
    );
    const byRotation = await drain(async () => {
      sent.length = 0;
      await selectorListener.handleWork({ userId: ownerId, workType: 'answer_infer' });

      return sent[0]?.questionId ?? null;
    });

    // The two selectors are one definition, which is what lets the gate mirror
    // them with one set of facts. If this fails, they have drifted from each other.
    expect(byRotation).toEqual(byUser);

    const verdicts: Record<string, { selectorQueues: boolean; gateRunsModel: boolean }> = {};

    for (const [name, id] of Object.entries(ids)) {
      verdicts[name] = { selectorQueues: byUser.has(id), gateRunsModel: await jobRunsModel(id) };
    }

    const yes = { selectorQueues: true, gateRunsModel: true };
    const no = { selectorQueues: false, gateRunsModel: false };

    expect(verdicts).toEqual({
      active: yes,
      inactive: no,
      handEntry: no,
      forkedOrigin: no,
      ownFork: yes,
      retiredForkOrigin: no,
      retiredFork: no,
      forkedByOtherOnly: yes,
      othersFork: no,
      ownPrivate: yes,
      othersPrivate: no,
      missing: no,
    });
  });

  // The incident, in order. Queued while eligible — so the selectors DID choose
  // it — then changed while the job sat in pg-boss, then run. Before the gate
  // each of these still reached the model and wrote an answer onto the row.
  //
  // Each change is a function rather than a statement because the fork is a new
  // row, not an edit; `runner` and `ownerId` are read when the test runs, not
  // when this table is built.
  const CHANGES_WHILE_QUEUED: Array<[string, (questionId: string) => Promise<unknown>]> = [
    [
      'deactivated',
      (questionId) =>
        runner.query('UPDATE ci.questions SET is_active = false WHERE question_id = $1', [questionId]),
    ],
    [
      're-marked hand_entry',
      (questionId) =>
        runner.query(`UPDATE ci.questions SET evidence_class = 'hand_entry' WHERE question_id = $1`, [
          questionId,
        ]),
    ],
    [
      'forked by the owner',
      (questionId) =>
        insertQuestion({
          id: randomUUID(),
          label: 'the owner’s fork of it',
          privateTo: ownerId,
          forkedFrom: questionId,
        }),
    ],
  ];

  it.each(CHANGES_WHILE_QUEUED)(
    'stops a job queued while the question was eligible and run after it was %s',
    async (_change, applyChange) => {
      await inSavepoint(async () => {
        const queuedFor = randomUUID();

        await insertQuestion({ id: queuedFor, label: 'queued, then changed' });

        expect(await jobRunsModel(queuedFor)).toBe(true);

        await applyChange(queuedFor);

        expect(await jobRunsModel(queuedFor)).toBe(false);
      });
    },
  );
});
