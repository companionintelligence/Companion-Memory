import { DatabaseUnavailableError, type TransientRetryPolicy } from '@ci/common/persistence';
import type { CreateCommunicationDto } from '@ci/domains/memory';

import type { StagedItem } from '../../entities/StagedItemEntity';
import type { StageRunContext } from '../../types';
import { PushStage } from '../PushStage';

/**
 * A database that stops answering is not a poisoned row.
 *
 * The incident: Postgres crash-restarted in the middle of a 700k-row Takeout
 * push and, for a few seconds, answered every statement with SQLSTATE 57P03 —
 * "the database system is in recovery mode", then "…is not yet accepting
 * connections". The batch failed, degraded to per-row, every row failed the
 * same way, and the per-row quarantine marked 437 good rows `failed` across
 * six data sources. The push reads only `pending`, so nothing ever looked at
 * them again.
 *
 * What is pinned here is the contract that replaces that:
 *
 *  - an outage is WAITED OUT, batch and row alike, before anything degrades or
 *    is quarantined;
 *  - an outage that outlasts the wait FAILS THE STAGE with the rows still
 *    `pending`, which is the state a retried stage resumes from;
 *  - a row the database actually rejected is still quarantined, exactly as
 *    before — the per-row isolation is untouched;
 *  - a write the database keeps going down UNDER is not resent into every
 *    restart: a batch is resent once, then isolated row by row, and the row
 *    that crashes it is quarantined as `crashed_database` — while a wait for a
 *    server still in recovery never counts against anything.
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

/**
 * A Postgres that crashes whenever `crashesOn` says the statement is poison,
 * then answers 57P03 for `recoveryCalls` statements while it comes back — the
 * TimescaleDB-segfault shape. `downForGood` makes it stop coming back.
 */
function crashingServer(options: {
  crashesOn: (input: CreateCommunicationDto[]) => boolean;
  recoveryCalls?: number;
  downForGood?: () => boolean;
}) {
  let recovering = 0;
  let crashes = 0;
  const sent: Array<{ size: number; outcome: 'crash' | 'recovering' | 'written' }> = [];

  const respond = (input: CreateCommunicationDto[]): Array<{ inserted: boolean }> => {
    if (recovering > 0 || options.downForGood?.() === true) {
      recovering = Math.max(0, recovering - 1);
      sent.push({ size: input.length, outcome: 'recovering' });

      throw inRecovery();
    }

    if (options.crashesOn(input)) {
      crashes += 1;
      recovering = options.recoveryCalls ?? 2;
      sent.push({ size: input.length, outcome: 'crash' });

      throw terminated();
    }

    sent.push({ size: input.length, outcome: 'written' });

    return input.map(() => ({ inserted: true }));
  };

  return { respond, sent, crashes: () => crashes };
}

const hasText = (input: CreateCommunicationDto[], text: string) =>
  input.some((message) => message.content === text);

let nextId = 0;

function messageRow(text: string): StagedItem {
  nextId += 1;

  return {
    id: `44444444-4444-4444-8444-4444444444${String(nextId).padStart(2, '0')}`,
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
function fakeClock(): TransientRetryPolicy & { slept: number[] } {
  let at = 0;
  const slept: number[] = [];

  return {
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    budgetMs: 180_000,
    slept,
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
  };
}

interface Options {
  /** Each call to communications.createManyDetailed, in order; default writes everything. */
  respond?: (input: CreateCommunicationDto[], call: number) => Array<{ inserted: boolean }>;
  /** Fail a ledger/read statement before it runs; return null to let it through. */
  interrupt?: (sql: string) => Error | null;
  entities?: ReturnType<typeof stagedEntity>[];
  /** graph.ingest, by call. */
  ingest?: (
    keys: string[],
    call: number,
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

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
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
      sendCalls += 1;
      callSizes.push(input.length);

      return options.respond?.(input, sendCalls) ?? input.map(() => ({ inserted: true }));
    }),
  };

  const graph = {
    ingest: jest.fn(async (_ctx: unknown, input: { entities: Array<{ key: string }> }) => {
      ingestCalls += 1;
      const keys = input.entities.map((entity) => entity.key);
      ingested.push(keys);

      return {
        relationships: [],
        ...(options.ingest?.(keys, ingestCalls) ?? {
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

  const stage = new PushStage(
    dataSource as never,
    communications as never,
    noop as never,
    noop as never,
    noop as never,
    { upsertFromExtraction: jest.fn(async () => undefined) } as never,
    noop as never,
    { createMany: jest.fn(async () => undefined) } as never,
    { upsertForSubjects: jest.fn(async () => 0) } as never,
    { create: jest.fn(async () => undefined) } as never,
    noop as never,
    graph as never,
    { send: jest.fn(async () => undefined) } as never,
    logger as never,
  );

  const clock = fakeClock();

  stage.transientRetry = clock;

  const itemUpdates = (status: string) =>
    updates.filter((update) => update.sql.includes('staged_items') && update.sql.includes(`'${status}'`));
  const entityMarks = () =>
    updates
      .filter((update) => update.sql.includes('UPDATE ci_import.staged_entities'))
      .map((update) => ({ id: String(update.params[0]), status: String(update.params[1]) }));

  return { stage, callSizes, updates, itemUpdates, entityMarks, ingested, clock, logger };
}

const context: StageRunContext = {
  runId: RUN_ID,
  userId: USER_ID,
  stageId: STAGE_ID,
  scratchDir: '/tmp/does-not-matter',
  progress: jest.fn(async () => undefined),
} as unknown as StageRunContext;

describe('an outage mid-push is waited out, not quarantined', () => {
  it.each([
    ['57P03 in recovery mode', inRecovery],
    [
      '57P03 not yet accepting connections',
      () => queryFailed('57P03', 'the database system is not yet accepting connections'),
    ],
    [
      '57P02 crash shutdown',
      () => queryFailed('57P02', 'terminating connection because of crash of another server process'),
    ],
    [
      'a refused socket',
      () => Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED' }),
    ],
    ['pg with no code at all', () => new Error('Connection terminated unexpectedly')],
  ])('sends the batch again, as a batch, after %s', async (_label, outage) => {
    const { stage, callSizes, itemUpdates, clock } = makeStage(
      [messageRow('a'), messageRow('b'), messageRow('c')],
      {
        respond: (input, call) => {
          // The outage, then the server still coming back from it.
          if (call === 1) {
            throw outage();
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
    // because the rows were never the problem. One crash with the batch in
    // flight is not enough to suspect it: another backend may have crashed.
    expect(callSizes).toEqual([3, 3, 3]);
    expect(clock.slept).toEqual([1_000, 2_000]);
    expect(itemUpdates('failed')).toEqual([]);
    expect(itemUpdates('pushed')[0].params[0]).toHaveLength(3);
    expect(outcome.partial).toBe(false);
    expect(outcome.detail).toMatchObject({ pushed: 3, failed: 0 });
  });

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
    // which is exactly what the stage retry resumes from.
    expect(itemUpdates('failed')).toEqual([]);
    expect(updates.filter((update) => update.sql.includes('staged_items'))).toEqual([]);

    // And the wait was bounded — long enough for a crash recovery, no longer.
    const waited = clock.slept.reduce((sum, ms) => sum + ms, 0);

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

  it('repeats a ledger write that met the restart instead of failing the stage over it', async () => {
    let interrupted = false;

    const { stage, itemUpdates, clock } = makeStage([messageRow('a')], {
      interrupt: (sql) => {
        if (!interrupted && sql.includes("push_status = 'pushed'")) {
          interrupted = true;

          return new Error('Connection terminated unexpectedly');
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

describe('a write that keeps taking the database down', () => {
  it('isolates the row that crashes the database instead of resending its batch into every restart', async () => {
    const rows = [messageRow('fine'), messageRow('poison'), messageRow('after')];
    const server = crashingServer({ crashesOn: (input) => hasText(input, 'poison') });

    const { stage, itemUpdates, updates, clock } = makeStage(rows, { respond: server.respond });

    const outcome = await stage.run(context);

    // The batch met two crashes and was not sent a third time.
    expect(server.sent.filter((send) => send.size === 3 && send.outcome === 'crash')).toHaveLength(2);
    expect(server.sent.filter((send) => send.size === 3 && send.outcome === 'written')).toEqual([]);
    // Alone, the poison row met two crashes of its own and was then left alone:
    // four restarts in all, not one every few seconds for three minutes.
    expect(server.crashes()).toBe(4);
    // …and the waits for the server to come back (57P03) between its two
    // crashes did not count against it: it was sent into a crash exactly twice.
    expect(server.sent.filter((send) => send.size === 1 && send.outcome === 'crash')).toHaveLength(2);

    const failed = itemUpdates('failed');

    expect(failed).toHaveLength(1);
    expect(failed[0].params[0]).toBe(rows[1].id);
    expect(String(failed[0].params[1])).toMatch(/^crashed_database: the database went down 2 time\(s\)/);
    expect(String(failed[0].params[1])).toContain('Connection terminated unexpectedly');

    // Its neighbours went, and the quarantine was written before the batch's
    // outcomes — the moment it was decided.
    expect(itemUpdates('pushed')[0].params[0]).toEqual([rows[0].id, rows[2].id]);
    expect(updates.indexOf(failed[0])).toBeLessThan(updates.indexOf(itemUpdates('pushed')[0]));
    expect(outcome.detail).toMatchObject({ pushed: 2, failed: 1 });

    // Bounded: a budget for the batch, one more for the row-by-row pass.
    expect(clock.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(360_000);
  });

  it('gives a row that met ONE crash the benefit of the doubt, and does not count the recovery', async () => {
    const rows = [messageRow('flaky'), messageRow('steady')];
    let flakySentAlone = 0;
    const server = crashingServer({
      crashesOn: (input) => {
        if (input.length > 1) {
          return true;
        }

        if (hasText(input, 'flaky')) {
          flakySentAlone += 1;

          return flakySentAlone === 1;
        }

        return false;
      },
    });

    const { stage, itemUpdates } = makeStage(rows, { respond: server.respond });

    const outcome = await stage.run(context);

    // A crash, then two 57P03s while the server came back, and still written:
    // had the 57P03s counted, the second would have quarantined it.
    expect(server.sent.filter((send) => send.size === 1 && send.outcome === 'crash')).toHaveLength(1);
    expect(itemUpdates('failed')).toEqual([]);
    expect(itemUpdates('pushed')[0].params[0]).toEqual([rows[0].id, rows[1].id]);
    expect(outcome.detail).toMatchObject({ pushed: 2, failed: 0 });
  });

  it('keeps the quarantine, and the total wait, when the database then stays away for good', async () => {
    const rows = [messageRow('poison'), messageRow('next'), messageRow('last')];
    let gone = false;
    const server = crashingServer({
      crashesOn: (input) => {
        if (!hasText(input, 'poison')) {
          return false;
        }

        // The second crash with the poison row alone is the last one: the
        // server does not come back after it.
        if (input.length === 1 && server.sent.filter((send) => send.size === 1).length >= 3) {
          gone = true;
        }

        return true;
      },
      downForGood: () => gone,
    });

    const { stage, itemUpdates, clock } = makeStage(rows, { respond: server.respond });

    const failure = await stage.run(context).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);

    // The poison row is in the ledger although the stage failed, so the stage
    // retry does not find it `pending` and take the database down with it again.
    const failed = itemUpdates('failed');

    expect(failed).toHaveLength(1);
    expect(failed[0].params[0]).toBe(rows[0].id);
    expect(String(failed[0].params[1])).toMatch(/^crashed_database: /);
    // Nothing else was written off: the rest wait, `pending`, for the retry.
    expect(itemUpdates('pushed')).toEqual([]);

    // ONE allowance for the whole row-by-row pass — the poison row's waits and
    // the next row's wait for a server that never came back — not a fresh
    // three minutes per row. The batch before it waited on its own budget:
    // 1s + 2s + 4s around its two crashes.
    const waited = clock.slept.reduce((sum, ms) => sum + ms, 0);
    const batchWaited = 7_000;

    expect(waited - batchWaited).toBeLessThanOrEqual(180_000);
    expect(waited - batchWaited).toBeGreaterThan(120_000);
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

  it('re-sends the entities ingest could not resolve because the database was away', async () => {
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

    const result = await (stage as unknown as EntityPusher).pushEntities(context, 'balanced', null);

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

    await expect(
      (stage as unknown as EntityPusher).pushEntities(context, 'balanced', null),
    ).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(entityMarks().filter((mark) => mark.status === 'failed')).toEqual([]);
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

    const result = await (stage as unknown as EntityPusher).pushEntities(context, 'balanced', null);

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

    const result = await (stage as unknown as EntityPusher).pushEntities(context, 'balanced', null);

    expect(result).toMatchObject({ resolved: 1, failed: 1 });
    expect(entityMarks().map((mark) => mark.status)).toEqual(['pushed', 'failed']);
    // No wait: nothing about that refusal would change in a minute.
    expect(ingested).toHaveLength(1);
    expect(clock.slept).toEqual([]);
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
});
