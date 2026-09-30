import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { QuestionService } from '../QuestionService';

/**
 * `recordFeedQuestionPresentation` against a real Postgres.
 *
 * It is the only thing that increments `ci.questions.times_asked`, and for as
 * long as it gated that increment on `rows[0]?.updated` it never did: the gate
 * read a bare `UPDATE … RETURNING`, which TypeORM resolves to the pair
 * `[rows, rowCount]`, so `rows[0]` was the rows ARRAY and `.updated` was always
 * undefined. A mocked `query` answers whatever it is told to and cannot see
 * that; only the driver can.
 *
 * Opt-in: set `DATABASE_URL` (or `DATABASE_PASSWORD`, as `yarn test` does from
 * the repo-root `.env`) to a migrated database. The suite SKIPS, and says so,
 * when nothing is reachable.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[intelligence/QuestionService.presentation.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`QuestionService feed presentations, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: QuestionService;

  const userId = randomUUID();
  /** In this user's feed queue. */
  const queued = randomUUID();
  /** Not in anyone's feed queue. */
  const unqueued = randomUUID();

  const timesAsked = async (questionId: string): Promise<number> => {
    const [row] = (await dataSource.query(`SELECT times_asked FROM ci.questions WHERE question_id = $1`, [
      questionId,
    ])) as Array<{ times_asked: number }>;

    return row.times_asked;
  };

  const lastPresentedAt = async (): Promise<string | null> => {
    const [row] = (await dataSource.query(
      `SELECT metadata->>'lastPresentedAt' AS at FROM ci.feed_queue WHERE user_id = $1 AND question_id = $2`,
      [userId, queued],
    )) as Array<{ at: string | null }>;

    return row.at;
  };

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

    // SHARED: this suite commits ci.users / ci.questions / ci.feed_queue rows.
    // See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'intelligence/QuestionService.presentation.integration',
    );

    await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params as unknown[]),
      'QuestionPresentation',
      userId,
    );

    // Private to the fixture user, so neither question can surface in another
    // account's feed on a shared database while the suite runs.
    for (const questionId of [queued, unqueued]) {
      await dataSource.query(
        `INSERT INTO ci.questions (question_id, question_text, is_private_to) VALUES ($1, $2, $3)`,
        [questionId, 'Presentation spec fixture?', userId],
      );
    }

    await dataSource.query(
      `INSERT INTO ci.feed_queue (feed_queue_id, user_id, question_id) VALUES ($1, $2, $3)`,
      [randomUUID(), userId, queued],
    );

    // Only `dataSource` is reached by the method under test.
    service = new QuestionService(dataSource, {} as never, {} as never);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DELETE FROM ci.feed_queue WHERE user_id = $1`, [userId]);
      await dataSource.query(`DELETE FROM ci.questions WHERE is_private_to = $1`, [userId]);
      await dataSource.query(`DELETE FROM ci.users WHERE id = $1`, [userId]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('stamps the first presentation on the feed row and counts it on the question', async () => {
    await service.recordFeedQuestionPresentation(userId, queued);

    expect(await lastPresentedAt()).not.toBeNull();
    expect(await timesAsked(queued)).toBe(1);
  });

  it('does not count a presentation that is already stamped', async () => {
    await service.recordFeedQuestionPresentation(userId, queued);
    await service.recordFeedQuestionPresentation(userId, queued);

    expect(await timesAsked(queued)).toBe(1);
  });

  it('counts the question again once a rotation has cleared the stamp', async () => {
    // What `rotateFeedQueueRow` does to the stamp when the row goes to the back
    // of the queue: the next time it reaches the front, it is asked again.
    await dataSource.query(
      `UPDATE ci.feed_queue SET metadata = metadata - 'lastPresentedAt' WHERE user_id = $1 AND question_id = $2`,
      [userId, queued],
    );

    await service.recordFeedQuestionPresentation(userId, queued);

    expect(await timesAsked(queued)).toBe(2);
  });

  it("leaves a question alone when it is not in the caller's feed", async () => {
    await service.recordFeedQuestionPresentation(userId, unqueued);

    expect(await timesAsked(unqueued)).toBe(0);
  });
});
