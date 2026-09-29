import { DatabaseUnavailableError, type TransientRetryPolicy } from '@ci/common/persistence';
import type { CreateCommunicationDto } from '@ci/domains/memory';

import type { StagedItem } from '../../entities/StagedItemEntity';
import type { StageRunContext } from '../../types';
import { DatabaseCrashedDuringPushError } from '../DatabaseCrashedDuringPushError';
import { PushStage, relationshipErrorMessage } from '../PushStage';

/**
 * A database that stops answering is not a poisoned row — and a database that
 * crashes under a write is not to be sent that write again.
 *
 * The first incident: Postgres crash-restarted in the middle of a 700k-row
 * Takeout push and, for a few seconds, answered every statement with SQLSTATE
 * 57P03 — "the database system is in recovery mode", then "…is not yet
 * accepting connections". The batch failed, degraded to per-row, every row
 * failed the same way, and the per-row quarantine marked 437 good rows `failed`
 * across six data sources. The push reads only `pending`, so nothing ever
 * looked at them again.
 *
 * The second: a statement can CRASH Postgres (a TimescaleDB 2.28 segfault
 * during a bulk upsert). Waiting that out and resending restarted the database
 * ten times in three minutes; isolating the row in-process crashed it four
 * times per poison row, never isolated it when recovery took over a minute,
 * and — when every write crashed the server — quarantined good rows as
 * `crashed_database` over dozens of crashes.
 *
 * What is pinned here is the contract that replaces both:
 *
 *  - a database that is NOT READY (never took the statement) is WAITED OUT,
 *    batch and row alike, and never degrades a batch or quarantines a row;
 *  - one that stays not-ready past the wait FAILS THE STAGE with the rows still
 *    `pending`;
 *  - one that CRASHED with a statement in flight fails the stage AT ONCE —
 *    one crash per attempt, the statement never resent, no row written off —
 *    with the rows `pending` for a person to re-drive;
 *  - a row the database actually rejected is still quarantined, exactly as
 *    before.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const STAGE_ID = '22222222-2222-4222-8222-222222222222';

/** TypeORM's QueryFailedError, as the push actually receives it. */
function queryFailed(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: 'QueryFailedError',
    code,
    driverError: Object.assign(new Error(message), { code }),
  });
}

const inRecovery = () => queryFailed('57P03', 'the database system is in recovery mode');
const notNull = () => queryFailed('23502', 'null value in column "content" violates not-null constraint');
/** What pg raises when the backend running OUR statement dies under it: no code at all. */
const terminated = () => new Error('Connection terminated unexpectedly');

const hasText = (input: CreateCommunicationDto[], text: string) =>
  input.some((message) => message.content === text);

let nextId = 0;

function messageRow(text: string): StagedItem {
  nextId += 1;

  return {
    id: `44444444-4444-4444-8444-${String(nextId).padStart(12, '0')}`,
    runId: RUN_ID,
    userId: USER_ID,
    dataSource: 'google_voice',
    classification: 'message',
    contentHash: `hash-${nextId}`,
    occurredAt: new Date('2024-05-01T12:00:00Z'),
    timespanEnd: null,
    latitude: null,
    longitude: null,
    filename: null,
    mediaType: null,
    originalLocation: null,
    intermediateLocation: null,
    metadata: { Sender: 'Sam Example', Source: 'Google Voice', Text: text },
    createdAt: new Date('2026-09-27T00:00:00Z'),
  } as unknown as StagedItem;
}

/**
 * A receipt that STATES a place (`Address`) and names no staged place entity, so
 * the push must resolve one through `graph.ingest` — the lookup under test.
 * Routed to `receipts` alone (`commerce.receipt`).
 */
function receiptRow(address: string): StagedItem {
  nextId += 1;

  return {
    id: `55555555-5555-4555-8555-${String(nextId).padStart(12, '0')}`,
    runId: RUN_ID,
    userId: USER_ID,
    dataSource: 'gmail',
    classification: 'receipt',
    contentHash: `hash-${nextId}`,
    occurredAt: new Date('2024-05-01T12:00:00Z'),
    timespanEnd: null,
    latitude: null,
    longitude: null,
    filename: null,
    mediaType: null,
    originalLocation: null,
    intermediateLocation: null,
    metadata: { Merchant: 'Blue Bottle', Total: '4.50', Currency: 'USD', Address: address },
    createdAt: new Date('2026-09-27T00:00:00Z'),
  } as unknown as StagedItem;
}

function stagedEntity(i: number) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    runId: RUN_ID,
    userId: USER_ID,
    type: 'contact',
    name: `Contact ${i}`,
    metadata: {},
    identityKey: `555010${String(i).padStart(4, '0')}`,
    dataSource: 'google_voice',
  };
}

/** A clock that never really sleeps, and remembers every pause it was asked for. */
function fakeClock(): TransientRetryPolicy & {
  slept: number[];
  now: () => number;
  advance: (ms: number) => void;
} {
  let at = 0;
  const slept: number[] = [];

  return {
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    budgetMs: 180_000,
    slept,
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
  };
}

/**
 * A Postgres on that clock. `crash(recoveryMs)` takes it down the way a crash
 * with our statement in flight does: that statement gets pg's bare
 * "Connection terminated unexpectedly", and EVERY statement after it — reads,
 * ledger writes, destination writes — gets 57P03 until recovery is over.
 * `outage(ms)` is the same recovery with no crash in front of it: the 57P03
 * incident.
 */
function fakeDatabase(clock: { now: () => number }) {
  let upAt = Number.NEGATIVE_INFINITY;
  let crashes = 0;

  return {
    /** Refuse the statement with 57P03 while the server is coming back. */
    gate(): void {
      if (clock.now() < upAt) {
        throw inRecovery();
      }
    },
    crash(recoveryMs: number): Error {
      crashes += 1;
      upAt = clock.now() + recoveryMs;

      return terminated();
    },
    outage(ms: number): void {
      upAt = clock.now() + ms;
    },
    crashes: () => crashes,
  };
}

type FakeDatabase = ReturnType<typeof fakeDatabase>;

interface Options {
  /**
   * Each call to communications.createManyDetailed that the database let
   * through, in order; default writes everything.
   */
  respond?: (input: CreateCommunicationDto[], call: number, db: FakeDatabase) => Array<{ inserted: boolean }>;
  /** Fail a ledger/read statement before it runs; return null to let it through. */
  interrupt?: (sql: string) => Error | null;
  entities?: ReturnType<typeof stagedEntity>[];
  /** graph.ingest, by call. */
  ingest?: (
    keys: string[],
    call: number,
    db: FakeDatabase,
  ) => { entities: Array<{ key: string; entityId: string }>; errors: string[] };
  /** readSelfIdentity's lookup, by call. */
  owner?: (call: number) => Array<{ name: string | null; email: string | null; phones_json: unknown }>;
}

function makeStage(rows: StagedItem[], options: Options = {}) {
  let servedBatch = false;
  let sendCalls = 0;
  let ingestCalls = 0;
  let ownerCalls = 0;
  const callSizes: number[] = [];
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const ingested: string[][] = [];
  const clock = fakeClock();
  const db = fakeDatabase(clock);

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      db.gate();

      const interruption = options.interrupt?.(sql);

      if (interruption) {
        throw interruption;
      }

      if (sql.includes('pg_database_size')) {
        return [{ bytes: '1000' }];
      }

      if (sql.includes('data_directory')) {
        return [];
      }

      if (sql.trimStart().startsWith('UPDATE')) {
        updates.push({ sql, params });

        return [];
      }

      if (sql.includes('INSERT INTO ci_import.entity_mappings')) {
        return [];
      }

      if (sql.includes('staged_relationships')) {
        return [];
      }

      if (sql.includes('SELECT entity_id FROM ci.users')) {
        return [{ entity_id: null }];
      }

      if (sql.includes('trust_mode')) {
        return [{ trust_mode: 'balanced' }];
      }

      if (sql.includes('FROM ci.users u')) {
        ownerCalls += 1;

        return options.owner?.(ownerCalls) ?? [];
      }

      if (sql.includes('AS unrouted') || sql.includes('DISTINCT ON (data_source)')) {
        return [];
      }

      if (sql.includes('FROM ci_import.staged_entities') && sql.includes('GROUP BY 1, 2')) {
        return [];
      }

      if (sql.includes("'item' AS kind")) {
        return [];
      }

      if (sql.includes('identity_key AS "identityKey"')) {
        return options.entities ?? [];
      }

      if (sql.includes('count(*)')) {
        return [{ count: String(rows.length) }];
      }

      // refileUnrouted: rows an EARLIER attempt routed nowhere. Ahead of the
      // batch read below, which selects the same columns.
      if (sql.includes("push_status = 'skipped' AND push_error = $2")) {
        return [];
      }

      if (sql.includes('media_type AS "mediaType"')) {
        if (servedBatch) {
          return [];
        }

        servedBatch = true;

        return rows;
      }

      throw new Error(`unexpected query: ${sql}`);
    }),
  };

  const communications = {
    createManyDetailed: jest.fn(async (_ctx: unknown, input: CreateCommunicationDto[]) => {
      db.gate();
      sendCalls += 1;
      callSizes.push(input.length);

      return options.respond?.(input, sendCalls, db) ?? input.map(() => ({ inserted: true }));
    }),
  };

  const graph = {
    ingest: jest.fn(async (_ctx: unknown, input: { entities: Array<{ key: string }> }) => {
      ingestCalls += 1;
      const keys = input.entities.map((entity) => entity.key);
      ingested.push(keys);

      return {
        relationships: [],
        ...(options.ingest?.(keys, ingestCalls, db) ?? {
          entities: keys.map((key, i) => ({
            key,
            entityId: `99999999-9999-4999-8999-${String(i).padStart(12, '0')}`,
          })),
          errors: [],
        }),
      };
    }),
  };

  const noop = { createManyDetailed: jest.fn(async () => []), createDetailed: jest.fn(async () => []) };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const receipts = { upsertFromExtraction: jest.fn(async (..._args: unknown[]): Promise<void> => undefined) };

  const stage = new PushStage(
    dataSource as never,
    communications as never,
    noop as never,
    noop as never,
    noop as never,
    receipts as never,
    noop as never,
    { createMany: jest.fn(async () => undefined) } as never,
    { upsertForSubjects: jest.fn(async () => 0) } as never,
    { create: jest.fn(async () => undefined) } as never,
    noop as never,
    graph as never,
    { send: jest.fn(async () => undefined) } as never,
    logger as never,
  );

  stage.transientRetry = clock;

  const itemUpdates = (status: string) =>
    updates.filter((update) => update.sql.includes('staged_items') && update.sql.includes(`'${status}'`));
  const stagedItemUpdates = () => updates.filter((update) => update.sql.includes('staged_items'));
  const entityMarks = () =>
    updates
      .filter((update) => update.sql.includes('UPDATE ci_import.staged_entities'))
      .map((update) => ({ id: String(update.params[0]), status: String(update.params[1]) }));

  return {
    stage,
    db,
    graph,
    receipts,
    callSizes,
    updates,
    itemUpdates,
    stagedItemUpdates,
    entityMarks,
    ingested,
    clock,
    logger,
    /** Serve the batch again — a second stage attempt over rows still `pending`. */
    rearm: () => {
      servedBatch = false;
    },
  };
}

const context: StageRunContext = {
  runId: RUN_ID,
  userId: USER_ID,
  stageId: STAGE_ID,
  scratchDir: '/tmp/does-not-matter',
  progress: jest.fn(async () => undefined),
} as unknown as StageRunContext;

const totalSlept = (clock: { slept: number[] }) => clock.slept.reduce((sum, ms) => sum + ms, 0);

describe('a database that is not ready is waited out, not quarantined', () => {
  it.each([
    ['57P03 in recovery mode', inRecovery],
    [
      '57P03 not yet accepting connections',
      () => queryFailed('57P03', 'the database system is not yet accepting connections'),
    ],
    ['53300 too many clients', () => queryFailed('53300', 'sorry, too many clients already')],
    [
      'a refused socket',
      () =>
        Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), {
          code: 'ECONNREFUSED',
          syscall: 'connect',
        }),
    ],
    ['a pool connect timeout', () => new Error('timeout exceeded when trying to connect')],
  ])('sends the batch again, as a batch, after %s', async (_label, notReady) => {
    const { stage, callSizes, itemUpdates, clock } = makeStage(
      [messageRow('a'), messageRow('b'), messageRow('c')],
      {
        respond: (input, call) => {
          // Not ready, then still coming back.
          if (call === 1) {
            throw notReady();
          }

          if (call === 2) {
            throw inRecovery();
          }

          return input.map(() => ({ inserted: true }));
        },
      },
    );

    const outcome = await stage.run(context);

    // Refused, still recovering, then written — never degraded to per-row,
    // because the rows were never the problem.
    expect(callSizes).toEqual([3, 3, 3]);
    expect(clock.slept).toEqual([1_000, 2_000]);
    expect(itemUpdates('failed')).toEqual([]);
    expect(itemUpdates('pushed')[0].params[0]).toHaveLength(3);
    expect(outcome.partial).toBe(false);
    expect(outcome.detail).toMatchObject({ pushed: 3, failed: 0 });
  });

  it.each([30_000, 90_000, 150_000])(
    'rides out a %d ms outage of the whole database and completes with everything written',
    async (outageMs) => {
      const rows = [messageRow('a'), messageRow('b'), messageRow('c'), messageRow('d')];
      let started = false;

      const { stage, itemUpdates, stagedItemUpdates, clock, db } = makeStage(rows, {
        respond: (input) => {
          // The server goes into recovery just as the first write reaches it,
          // and refuses every statement — reads and ledger too — until it is
          // back. The 57P03 incident, with no crash in front of it.
          if (!started) {
            started = true;
            db.outage(outageMs);
            db.gate();
          }

          return input.map(() => ({ inserted: true }));
        },
      });

      const outcome = await stage.run(context);

      expect(db.crashes()).toBe(0);
      expect(outcome.partial).toBe(false);
      expect(outcome.detail).toMatchObject({ pushed: 4, failed: 0 });
      expect(itemUpdates('pushed')[0].params[0]).toEqual(rows.map((row) => row.id));
      expect(itemUpdates('failed')).toEqual([]);
      // One ledger write for the batch: nothing was written off on the way.
      expect(stagedItemUpdates()).toHaveLength(1);
      expect(totalSlept(clock)).toBeGreaterThanOrEqual(outageMs);
      expect(totalSlept(clock)).toBeLessThanOrEqual(180_000);
    },
  );

  it('fails the stage with every row still pending when the database stays away', async () => {
    const { stage, itemUpdates, updates, clock } = makeStage([messageRow('a'), messageRow('b')], {
      respond: () => {
        throw inRecovery();
      },
    });

    const failure = await stage.run(context).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as Error).message).toContain('the database system is in recovery mode');

    // The whole point: not one row was written off. They are still `pending`,
    // which is exactly what the re-drive resumes from.
    expect(itemUpdates('failed')).toEqual([]);
    expect(updates.filter((update) => update.sql.includes('staged_items'))).toEqual([]);

    // And the wait was bounded — long enough for a crash recovery, no longer.
    const waited = totalSlept(clock);

    expect(waited).toBeGreaterThan(60_000);
    expect(waited).toBeLessThanOrEqual(180_000);
  });

  it('still quarantines the row the database rejected, and waits out a blip on the next one', async () => {
    const rows = [messageRow('fine'), messageRow('poison'), messageRow('blip')];
    let blipped = false;

    const { stage, itemUpdates, clock } = makeStage(rows, {
      respond: (input) => {
        if (input.length > 1) {
          // One bad row rolls back the batch; the per-row pass finds it.
          throw notNull();
        }

        if (input[0].content === 'poison') {
          throw notNull();
        }

        if (input[0].content === 'blip' && !blipped) {
          blipped = true;
          throw inRecovery();
        }

        return [{ inserted: true }];
      },
    });

    const outcome = await stage.run(context);

    const failed = itemUpdates('failed');

    // Exactly the poisoned row, for the database's own reason.
    expect(failed).toHaveLength(1);
    expect(failed[0].params[0]).toBe(rows[1].id);
    expect(String(failed[0].params[1])).toContain('violates not-null constraint');
    // The blip cost one pause and the row went.
    expect(clock.slept).toEqual([1_000]);
    expect(itemUpdates('pushed')[0].params[0]).toEqual([rows[0].id, rows[2].id]);
    expect(outcome.detail).toMatchObject({ pushed: 2, failed: 1 });
  });

  it('repeats a ledger write the database was not ready for, instead of failing the stage over it', async () => {
    let refused = false;

    const { stage, itemUpdates, clock } = makeStage([messageRow('a')], {
      interrupt: (sql) => {
        if (!refused && sql.includes("push_status = 'pushed'")) {
          refused = true;

          return queryFailed('57P03', 'the database system is not yet accepting connections');
        }

        return null;
      },
    });

    await stage.run(context);

    expect(clock.slept).toEqual([1_000]);
    expect(itemUpdates('pushed')).toHaveLength(1);
  });

  it('waits out an outage on the very first read of the stage', async () => {
    let refusals = 2;

    const { stage, itemUpdates, clock } = makeStage([messageRow('a')], {
      interrupt: (sql) => {
        if (refusals > 0 && sql.includes("'item' AS kind")) {
          refusals -= 1;

          return queryFailed('57P03', 'the database system is not yet accepting connections');
        }

        return null;
      },
    });

    await stage.run(context);

    expect(clock.slept).toEqual([1_000, 2_000]);
    expect(itemUpdates('pushed')).toHaveLength(1);
  });
});

describe('a database that crashed with a statement in flight stops the push', () => {
  it.each([
    ['pg with no code at all', terminated],
    [
      '57P02 crash shutdown',
      () => queryFailed('57P02', 'terminating connection because of crash of another server process'),
    ],
    [
      '57P01 admin shutdown',
      () => queryFailed('57P01', 'terminating connection due to administrator command'),
    ],
    [
      'a reset socket',
      () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }),
    ],
    ['a broken pipe', () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' })],
  ])(
    'fails the stage at once after %s, the batch not resent and no row written off',
    async (_label, crash) => {
      const { stage, callSizes, stagedItemUpdates, clock } = makeStage(
        [messageRow('a'), messageRow('b'), messageRow('c')],
        {
          respond: () => {
            throw crash();
          },
        },
      );

      const failure = await stage.run(context).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DatabaseCrashedDuringPushError);
      // Sent once. Not again as a batch, not degraded to single rows.
      expect(callSizes).toEqual([3]);
      expect(clock.slept).toEqual([]);
      // Every row still `pending`: nothing in the ledger was touched.
      expect(stagedItemUpdates()).toEqual([]);
    },
  );

  it('says what happened and how to re-drive it, and names the rows that were in flight', async () => {
    const rows = [messageRow('a'), messageRow('b')];
    const { stage, logger } = makeStage(rows, {
      respond: (_input, _call, db) => {
        throw db.crash(30_000);
      },
    });

    const failure = (await stage.run(context).catch((err: unknown) => err)) as DatabaseCrashedDuringPushError;

    expect(failure.message).toBe(
      'the database crashed while this push was writing 2 communications record(s); rows are left pending — ' +
        `re-drive with \`ci push --run ${RUN_ID} --retry-failed\` once the database is healthy ` +
        '(last error: Connection terminated unexpectedly)',
    );
    expect(failure.runId).toBe(RUN_ID);
    expect(failure.cause).toBeInstanceOf(Error);
    expect(logger.error).toHaveBeenCalledWith(
      'The database crashed with these staged rows in flight; the push stops here',
      expect.objectContaining({
        runId: RUN_ID,
        destination: 'communications',
        rows: 2,
        firstStagedItemId: rows[0].id,
        lastStagedItemId: rows[1].id,
        dataSources: ['google_voice'],
      }),
    );
  });

  it.each([30_000, 90_000, 120_000])(
    'crashes the database exactly once per attempt over a poison row, with %d ms recovery',
    async (recoveryMs) => {
      const rows = [messageRow('fine'), messageRow('poison'), messageRow('after')];
      const { stage, db, stagedItemUpdates, clock, rearm } = makeStage(rows, {
        respond: (input, _call, server) => {
          if (hasText(input, 'poison')) {
            throw server.crash(recoveryMs);
          }

          return input.map(() => ({ inserted: true }));
        },
      });

      const first = await stage.run(context).catch((err: unknown) => err);

      expect(first).toBeInstanceOf(DatabaseCrashedDuringPushError);
      expect(db.crashes()).toBe(1);
      // No waiting in-process: the push does not sit out the recovery to send
      // the poison again, however long the recovery is.
      expect(clock.slept).toEqual([]);

      // A person re-drives it once the database is healthy. Same rows, same
      // crash — ONE more, not a loop — and still nothing written off: finding
      // the poison is theirs, with the logged row range to start from.
      clock.advance(recoveryMs);
      rearm();

      const second = await stage.run(context).catch((err: unknown) => err);

      expect(second).toBeInstanceOf(DatabaseCrashedDuringPushError);
      expect(db.crashes()).toBe(2);
      expect(clock.slept).toEqual([]);
      expect(stagedItemUpdates()).toEqual([]);
    },
  );

  it('crashes the database once, and quarantines nothing, when EVERY write crashes it', async () => {
    // The shape of a TimescaleDB bug that crashed on any insert into the table,
    // not on one row: in-process isolation crashed the server 53 times and
    // wrote off 25 good rows as `crashed_database`.
    const rows = Array.from({ length: 100 }, (_, i) => messageRow(`m${i}`));
    const { stage, db, callSizes, stagedItemUpdates, clock } = makeStage(rows, {
      respond: (_input, _call, server) => {
        throw server.crash(3_000);
      },
    });

    const failure = await stage.run(context).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCrashedDuringPushError);
    expect(db.crashes()).toBe(1);
    expect(callSizes).toEqual([100]);
    expect(clock.slept).toEqual([]);
    expect(stagedItemUpdates()).toEqual([]);
  });

  it('stops the row-by-row pass too, and writes off nothing — not even the row the database rejected', async () => {
    // The batch was REJECTED (a real refusal, so it degrades to single rows),
    // and then one of the single rows crashes the server.
    const rows = [messageRow('bad'), messageRow('fine'), messageRow('poison'), messageRow('after')];
    const sentAlone: string[] = [];

    const { stage, db, stagedItemUpdates, clock } = makeStage(rows, {
      respond: (input, _call, server) => {
        if (input.length > 1) {
          throw notNull();
        }

        sentAlone.push(String(input[0].content));

        if (hasText(input, 'bad')) {
          throw notNull();
        }

        if (hasText(input, 'poison')) {
          throw server.crash(60_000);
        }

        return [{ inserted: true }];
      },
    });

    const failure = await stage.run(context).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCrashedDuringPushError);
    expect((failure as Error).message).toContain(`record ${rows[2].id}`);
    expect(db.crashes()).toBe(1);
    // Nothing after the poison row was sent.
    expect(sentAlone).toEqual(['bad', 'fine', 'poison']);
    expect(clock.slept).toEqual([]);
    // The rejected row is decided but not yet recorded; the stage stops before
    // the batch's outcomes are written, so it is re-decided on the re-drive.
    expect(stagedItemUpdates()).toEqual([]);
  });

  it('fails the stage when a READ or a ledger write meets the crash, and sends nothing after it', async () => {
    let crashed = false;

    const { stage, itemUpdates, clock, callSizes } = makeStage([messageRow('a')], {
      interrupt: (sql) => {
        if (!crashed && sql.includes("push_status = 'pushed'")) {
          crashed = true;

          return terminated();
        }

        return null;
      },
    });

    const failure = await stage.run(context).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCrashedDuringPushError);
    expect((failure as Error).message).toContain('while this push was recording pushed rows');
    // The write landed; the ledger did not, so the row stays `pending` and the
    // re-drive re-upserts it onto the same destination row.
    expect(callSizes).toEqual([1]);
    expect(itemUpdates('pushed')).toEqual([]);
    expect(clock.slept).toEqual([]);
  });
});

describe('the entity lane', () => {
  type EntityPusher = {
    pushEntities(
      context: StageRunContext,
      trustMode: string,
      selfEntityId: string | null,
    ): Promise<{ resolved: number; failed: number }>;
  };

  const pushEntities = (stage: PushStage) =>
    (stage as unknown as EntityPusher).pushEntities(context, 'balanced', null);

  it('re-sends the entities ingest could not resolve because the database was not ready', async () => {
    const entities = [stagedEntity(0), stagedEntity(1), stagedEntity(2), stagedEntity(3)];
    const { stage, entityMarks, ingested, clock } = makeStage([], {
      entities,
      // GraphIngestService catches a batch-level failure and reports it per
      // entity as TEXT — the SQLSTATE does not survive the trip.
      ingest: (keys, call) =>
        call === 1
          ? {
              // Half made it before the server went down.
              entities: keys.slice(0, 2).map((key, i) => ({ key, entityId: `e-${i}` })),
              errors: keys.slice(2).map((key) => `entity ${key}: the database system is in recovery mode`),
            }
          : {
              entities: keys.map((key, i) => ({ key, entityId: `f-${i}` })),
              errors: [],
            },
    });

    const result = await pushEntities(stage);

    expect(result).toMatchObject({ resolved: 4, failed: 0 });
    expect(entityMarks().map((mark) => mark.status)).toEqual(['pushed', 'pushed', 'pushed', 'pushed']);
    // The retry carries only what was still open, so nothing is resolved twice.
    expect(ingested).toHaveLength(2);
    expect(ingested[1]).toHaveLength(2);
    expect(clock.slept).toEqual([1_000]);
  });

  it('fails the stage rather than the entities when the database stays away', async () => {
    const { stage, entityMarks } = makeStage([], {
      entities: [stagedEntity(0), stagedEntity(1)],
      ingest: (keys) => ({
        entities: [],
        errors: keys.map((key) => `entity ${key}: the database system is not yet accepting connections`),
      }),
    });

    await expect(pushEntities(stage)).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(entityMarks().filter((mark) => mark.status === 'failed')).toEqual([]);
  });

  it('sends a batch that crashes the database exactly once, and fails the stage', async () => {
    // A poison entity: the database goes down whenever the batch holding it is
    // written. In-process waiting re-sent it ten times in 151s.
    const entities = [stagedEntity(0), stagedEntity(1)];
    const poison = `contact:${entities[1].identityKey}`;

    const { stage, entityMarks, ingested, clock, db } = makeStage([], {
      entities,
      ingest: (keys, _call, server) => {
        if (keys.includes(poison)) {
          server.crash(90_000);

          return {
            entities: [],
            errors: keys.map((key) => `entity ${key}: Connection terminated unexpectedly`),
          };
        }

        return { entities: keys.map((key, i) => ({ key, entityId: `e-${i}` })), errors: [] };
      },
    });

    const failure = await pushEntities(stage).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCrashedDuringPushError);
    expect((failure as Error).message).toContain('while this push was resolving 2 staged entities');
    expect(ingested).toEqual([[`contact:${entities[0].identityKey}`, poison]]);
    expect(db.crashes()).toBe(1);
    expect(clock.slept).toEqual([]);
    // Neither entity written off: both wait, `pending`, for the re-drive.
    expect(entityMarks()).toEqual([]);
  });

  it('reads only the message, never the key, when deciding the database was away', async () => {
    // The key is the contact's handle — user data. `contact:EPIPE Crew` used
    // to match the socket-code pattern, so a plain refusal was retried for the
    // whole budget and then failed the stage.
    const { stage, entityMarks, ingested, clock } = makeStage([], {
      entities: [{ ...stagedEntity(0), identityKey: 'EPIPE Crew' }],
      ingest: (keys) => ({
        entities: [],
        errors: [`entity ${keys[0]}: value too long for type character varying(255)`],
      }),
    });

    const result = await pushEntities(stage);

    expect(ingested).toEqual([['contact:EPIPE Crew']]);
    expect(result).toMatchObject({ resolved: 0, failed: 1 });
    expect(entityMarks()).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(clock.slept).toEqual([]);
  });

  it('still records an entity ingest refused for a reason of its own', async () => {
    const { stage, entityMarks, ingested, clock } = makeStage([], {
      entities: [stagedEntity(0), stagedEntity(1)],
      ingest: (keys) => ({
        entities: [{ key: keys[0], entityId: 'e-0' }],
        errors: [`entity ${keys[1]}: value too long for type character varying(255)`],
      }),
    });

    const result = await pushEntities(stage);

    expect(result).toMatchObject({ resolved: 1, failed: 1 });
    expect(entityMarks().map((mark) => mark.status)).toEqual(['pushed', 'failed']);
    // No wait: nothing about that refusal would change in a minute.
    expect(ingested).toHaveLength(1);
    expect(clock.slept).toEqual([]);
  });
});

describe('the receipts lane place lookup', () => {
  // `receiptPlacesFor` asks the graph for the place a receipt states. Ingest
  // catches a batch-level failure — a crash included — and reports it per
  // entity as `entity <key>: <message>`; the lookup used to read only the
  // resolved entities. The receipt write right behind it then met the
  // recovering server (57P03), which reads as "not ready", so the WHOLE group
  // was waited for and resent — the place lookup with it, crashing the database
  // again, 2-6 times per stage attempt until the 180s budget was spent.

  /** Whatever the receipt write was handed, by call. */
  const written = (receipts: { upsertFromExtraction: jest.Mock }) =>
    receipts.upsertFromExtraction.mock.calls.map(([, input]) => input as { placeEntityId?: string });

  it('crashes the database ONCE and fails the stage when ingest reports the crash as text', async () => {
    const rows = [receiptRow('1 Infinite Loop, Cupertino')];
    const { stage, db, receipts, ingested, stagedItemUpdates, clock } = makeStage(rows, {
      // The place upsert is what takes the server down — on EVERY attempt.
      ingest: (keys, _call, server) => {
        server.crash(60_000);

        return {
          entities: [],
          errors: keys.map((key) => `entity ${key}: Connection terminated unexpectedly`),
        };
      },
    });

    // The very next statement the old code sent: the recovering server.
    receipts.upsertFromExtraction.mockImplementation(async () => {
      db.gate();
    });

    const failure = (await stage.run(context).catch((err: unknown) => err)) as DatabaseCrashedDuringPushError;

    expect(failure).toBeInstanceOf(DatabaseCrashedDuringPushError);
    expect(failure.message).toContain('while this push was resolving 1 receipt place(s)');
    expect(failure.message).toContain('(last error: Connection terminated unexpectedly)');
    // ONE crash: the lookup was not resent, nor the group it belongs to, and
    // nothing was sent into the recovering server after it.
    expect(db.crashes()).toBe(1);
    expect(ingested).toHaveLength(1);
    expect(receipts.upsertFromExtraction).not.toHaveBeenCalled();
    expect(clock.slept).toEqual([]);
    // Every row still `pending`: nothing in the ledger was touched.
    expect(stagedItemUpdates()).toEqual([]);
  });

  it('does the same on the row-by-row pass, after a batch refused for a reason of its own', async () => {
    // The batch is REJECTED (a real refusal, so it degrades to single rows) and
    // the single row's own lookup is what crashes the server.
    const rows = [receiptRow('1 Infinite Loop, Cupertino')];
    const { stage, db, receipts, ingested, stagedItemUpdates, clock } = makeStage(rows, {
      ingest: (keys, call, server) => {
        if (call === 1) {
          return { entities: [], errors: [] };
        }

        server.crash(60_000);

        return {
          entities: [],
          errors: keys.map((key) => `entity ${key}: Connection terminated unexpectedly`),
        };
      },
    });

    receipts.upsertFromExtraction.mockImplementation(async () => {
      db.gate();

      // The batch call: refused for its own reasons.
      if (receipts.upsertFromExtraction.mock.calls.length === 1) {
        throw notNull();
      }
    });

    const failure = await stage.run(context).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCrashedDuringPushError);
    expect((failure as Error).message).toContain(`while this push was resolving 1 receipt place(s)`);
    expect(db.crashes()).toBe(1);
    // Once in the batch, once alone — and no third time after the crash.
    expect(ingested).toHaveLength(2);
    expect(receipts.upsertFromExtraction).toHaveBeenCalledTimes(1);
    expect(clock.slept).toEqual([]);
    expect(stagedItemUpdates()).toEqual([]);
  });

  it('waits out a place lookup the database was not ready for, and writes the receipt WITH its place', async () => {
    const rows = [receiptRow('1 Infinite Loop, Cupertino')];
    const { stage, receipts, ingested, itemUpdates, clock } = makeStage(rows, {
      ingest: (keys, call) =>
        call === 1
          ? {
              entities: [],
              errors: keys.map((key) => `entity ${key}: the database system is in recovery mode`),
            }
          : { entities: keys.map((key) => ({ key, entityId: 'place-entity-1' })), errors: [] },
    });

    const outcome = await stage.run(context);

    // Refused once, waited for, resolved: the receipt is NOT written without a
    // place because the first ask met a server that was not up.
    expect(ingested).toHaveLength(2);
    expect(clock.slept).toEqual([1_000]);
    expect(written(receipts)).toEqual([expect.objectContaining({ placeEntityId: 'place-entity-1' })]);
    expect(itemUpdates('failed')).toEqual([]);
    expect(itemUpdates('pushed')[0].params[0]).toEqual([rows[0].id]);
    expect(outcome.partial).toBe(false);
    expect(outcome.detail).toMatchObject({ pushed: 1, failed: 0 });
  });

  it('fails the stage, rows pending, when the place lookup keeps meeting a server that is not ready', async () => {
    const { stage, receipts, itemUpdates, stagedItemUpdates, clock } = makeStage(
      [receiptRow('1 Infinite Loop, Cupertino')],
      {
        ingest: (keys) => ({
          entities: [],
          errors: keys.map((key) => `entity ${key}: the database system is not yet accepting connections`),
        }),
      },
    );

    const failure = await stage.run(context).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect(receipts.upsertFromExtraction).not.toHaveBeenCalled();
    expect(itemUpdates('failed')).toEqual([]);
    expect(stagedItemUpdates()).toEqual([]);
    expect(totalSlept(clock)).toBeLessThanOrEqual(180_000);
  });

  it('still writes the receipt WITHOUT a place for a refusal about the place itself', async () => {
    const rows = [receiptRow('1 Infinite Loop, Cupertino')];
    const { stage, receipts, ingested, itemUpdates, clock } = makeStage(rows, {
      ingest: (keys) => ({
        entities: [],
        errors: keys.map((key) => `entity ${key}: value too long for type character varying(255)`),
      }),
    });

    const outcome = await stage.run(context);

    // A place that will not resolve costs the receipt its place, never its
    // import — and nothing about that refusal would change in a minute.
    expect(ingested).toHaveLength(1);
    expect(clock.slept).toEqual([]);
    expect(written(receipts)).toHaveLength(1);
    expect(written(receipts)[0].placeEntityId).toBeUndefined();
    expect(itemUpdates('failed')).toEqual([]);
    expect(itemUpdates('pushed')[0].params[0]).toEqual([rows[0].id]);
    expect(outcome.detail).toMatchObject({ pushed: 1, failed: 0 });
  });
});

describe('linking shared content to its events', () => {
  type Linker = {
    linkSharedContent(
      ctx: { userId: string; importRunId?: string },
      plans: Array<Record<string, unknown>>,
      context: StageRunContext,
    ): Promise<void>;
  };

  const plan = {
    contentId: '55555555-5555-4555-8555-555555555555',
    eventId: '66666666-6666-4666-8666-666666666666',
    contentInserted: false,
    failure: null,
  };

  const link = (stage: PushStage) =>
    (stage as unknown as Linker).linkSharedContent({ userId: USER_ID, importRunId: RUN_ID }, [plan], context);

  it('stays fail-soft for anything but a crash — the edge sweep catches a missed edge', async () => {
    const { stage, graph, logger } = makeStage([]);

    graph.ingest.mockRejectedValueOnce(inRecovery());
    await expect(link(stage)).resolves.toBeUndefined();

    graph.ingest.mockResolvedValueOnce({
      entities: [],
      relationships: [],
      errors: [`relationship content:${plan.contentId}->event:${plan.eventId}: endpoint not found in batch`],
    } as never);
    await expect(link(stage)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'Linking shared content rows to their events failed; the edge sweep will retry',
      expect.objectContaining({ edges: 1 }),
    );
  });

  it('fails the stage when the edge write crashed the database, thrown or reported', async () => {
    const { stage, graph } = makeStage([]);

    graph.ingest.mockRejectedValueOnce(terminated());
    await expect(link(stage)).rejects.toBeInstanceOf(DatabaseCrashedDuringPushError);

    // Ingest catches a batch-level edge failure and reports it per edge as text.
    graph.ingest.mockResolvedValueOnce({
      entities: [],
      relationships: [],
      errors: [
        `relationship content:${plan.contentId}->event:${plan.eventId}: Connection terminated unexpectedly`,
      ],
    } as never);

    const failure = await link(stage).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCrashedDuringPushError);
    expect((failure as Error).message).toContain('while this push was linking 1 shared content row(s)');
  });

  it('reads the message half of an edge error', () => {
    expect(relationshipErrorMessage('relationship content:a->event:b: read ECONNRESET')).toBe(
      'read ECONNRESET',
    );
    expect(relationshipErrorMessage('something else: entirely')).toBe('something else: entirely');
  });
});

describe('the owner lookup', () => {
  type SelfResolver = { resolveIsSelf(context: StageRunContext): Promise<(name: string) => boolean> };

  it('does not fall back to "nobody is the owner" because the database blinked', async () => {
    // The fail-safe is for an owner with no name on file. Applied to an outage
    // it would stamp every WhatsApp and Messenger message in the run `inbound`.
    const { stage, clock } = makeStage([], {
      owner: (call) => {
        if (call === 1) {
          throw inRecovery();
        }

        return [{ name: 'Alex Owner', email: 'alex.owner@example.com', phones_json: null }];
      },
    });

    const isSelf = await (stage as unknown as SelfResolver).resolveIsSelf(context);

    expect(isSelf('Alex Owner')).toBe(true);
    expect(clock.slept).toEqual([1_000]);
  });

  it('does not fall back either when the database crashed under the lookup', async () => {
    const { stage, clock } = makeStage([], {
      owner: () => {
        throw terminated();
      },
    });

    await expect((stage as unknown as SelfResolver).resolveIsSelf(context)).rejects.toBeInstanceOf(
      DatabaseCrashedDuringPushError,
    );
    expect(clock.slept).toEqual([]);
  });
});
