import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { Events } from '@ci/domains/events';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { SmartRotationListener } from '../SmartRotationListener';

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
 * READ-ONLY. It writes nothing: the attempt history it asserts against is
 * whatever pg-boss already recorded on the machine running the test.
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
});
