import type { CreateCommunicationDto } from '@ci/domains/memory';

import type { StagedItem } from '../../entities/StagedItemEntity';
import type { StageRunContext } from '../../types';
import { PushStage } from '../PushStage';

/**
 * How MANY calls a batch costs, which is the whole of this stage's throughput.
 *
 * The push read 500 staged rows at a time and then walked them one at a time,
 * spending at least three sequential round trips on each: one to read its
 * edges, one per destination handing a batch API a single-element array, and
 * one UPDATE to record the outcome. A real 704,226-row Google Takeout import
 * measured 1,000–3,500 rows/minute with Postgres sitting idle on ClientRead —
 * the database was waiting for the client, not working.
 *
 * These assertions are about call COUNTS and per-row attribution, because that
 * is what the batching changes and what it could get wrong: a batched write
 * that cannot say which rows it wrote would silently mark real writes as
 * duplicates.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const STAGE_ID = '22222222-2222-4222-8222-222222222222';

const OWNER_ROWS = [{ name: 'Liam Broza', email: 'liam.broza@example.com' }];

let nextId = 0;

function messageRow(text: string, over: Partial<StagedItem> = {}): StagedItem {
  nextId += 1;

  return {
    id: `44444444-4444-4444-8444-4444444444${String(nextId).padStart(2, '0')}`,
    runId: RUN_ID,
    userId: USER_ID,
    dataSource: 'whatsapp',
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
    metadata: { Sender: 'Alice Example', Conversation: 'Family', Source: 'WhatsApp', Text: text },
    createdAt: new Date('2026-08-12T00:00:00Z'),
    ...over,
  } as StagedItem;
}

interface Harness {
  stage: PushStage;
  /** One entry per createManyDetailed call: how many inputs it carried. */
  callSizes: number[];
  sent: CreateCommunicationDto[];
  /** Every UPDATE statement the stage issued against the staged-item ledger. */
  updates: Array<{ sql: string; params: unknown[] }>;
}

function makeStage(
  rows: StagedItem[],
  options: {
    /** Decides each call's fate from its inputs; default writes everything. */
    respond?: (input: CreateCommunicationDto[]) => Array<{ inserted: boolean }>;
    /** `ci.users.entity_id` — the owner's own entity. Default: no self row. */
    selfEntityId?: string | null;
    /** Rows the staged-edge join returns, i.e. the resolved participants. */
    relationships?: Array<{ item_id: string; relation: string | null; server_entity_id: string }>;
  } = {},
): Harness {
  let servedBatch = false;
  const callSizes: number[] = [];
  const sent: CreateCommunicationDto[] = [];
  const updates: Array<{ sql: string; params: unknown[] }> = [];

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
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

      if (sql.includes('staged_relationships')) {
        return options.relationships ?? [];
      }

      if (sql.includes('SELECT entity_id FROM ci.users')) {
        return [{ entity_id: options.selfEntityId ?? null }];
      }

      if (sql.includes('trust_mode')) {
        return [{ trust_mode: 'balanced' }];
      }

      if (sql.includes('FROM ci.users u')) {
        return OWNER_ROWS;
      }

      // The stage summary's read-back of the ledger (telemetry/stageSummary).
      // Ahead of the bare count(*) branch below, which these would otherwise
      // capture — they are grouped counts, not a scalar one. Empty is the
      // honest answer for a fake that never wrote a ledger row: what is under
      // test in this file is the push's control flow, not its telemetry, which
      // has its own tests.
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
        return [];
      }

      if (sql.includes('count(*)')) {
        return [{ count: String(rows.length) }];
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
      callSizes.push(input.length);
      const results = options.respond?.(input) ?? input.map(() => ({ inserted: true }));
      sent.push(...input);

      return results;
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
    // The commerce plane — unused by this test's records, but the constructor
    // takes them.
    { upsertFromExtraction: jest.fn(async () => undefined) } as never,
    noop as never,
    { createMany: jest.fn(async () => undefined) } as never,
    { upsertForSubjects: jest.fn(async () => 0) } as never,
    { create: jest.fn(async () => undefined) } as never,
    noop as never,
    { ingest: jest.fn(async () => ({ entities: [], errors: [] })) } as never,
    { send: jest.fn(async () => undefined) } as never,
    logger as never,
  );

  return { stage, callSizes, sent, updates };
}

const context: StageRunContext = {
  runId: RUN_ID,
  userId: USER_ID,
  stageId: STAGE_ID,
  scratchDir: '/tmp/does-not-matter',
  progress: jest.fn(async () => undefined),
} as unknown as StageRunContext;

describe('a batch costs one call per destination', () => {
  it('hands twenty rows to the service once, not twenty times', async () => {
    const { stage, callSizes, sent } = makeStage(Array.from({ length: 20 }, (_, i) => messageRow(`m${i}`)));

    await stage.run(context);

    expect(callSizes).toEqual([20]);
    expect(sent).toHaveLength(20);
  });

  it('records twenty outcomes in one UPDATE, not twenty', async () => {
    const { stage, updates } = makeStage(Array.from({ length: 20 }, (_, i) => messageRow(`m${i}`)));

    await stage.run(context);

    const ledger = updates.filter((update) => update.sql.includes('staged_items'));

    expect(ledger).toHaveLength(1);
    expect(ledger[0].sql).toContain("push_status = 'pushed'");
    expect(ledger[0].params[0]).toHaveLength(20);
  });
});

describe('a batched write still says which rows it wrote', () => {
  it('splits pushed from already-there within one call', async () => {
    // Every other row is a duplicate the service absorbed. Counting sends
    // instead of writes is what claimed 7,339 content records for an archive
    // that produced 2,354.
    const { stage, updates } = makeStage(
      Array.from({ length: 6 }, (_, i) => messageRow(`m${i}`)),
      {
        respond: (input) => input.map((_row, index) => ({ inserted: index % 2 === 0 })),
      },
    );

    await stage.run(context);

    const pushed = updates.find((update) => update.sql.includes("push_status = 'pushed'"));
    const skipped = updates.find((update) => update.sql.includes("push_status = 'skipped'"));

    expect(pushed?.params[0]).toHaveLength(3);
    expect(skipped?.params[0]).toHaveLength(3);
  });
});

describe('a failed batch degrades to per-row rather than losing the batch', () => {
  it('retries row by row and quarantines only the row that cannot be written', async () => {
    // One transaction per batch means one unacceptable row would otherwise roll
    // back 499 good ones — and mark them all failed, which is the outcome the
    // per-row quarantine exists to prevent.
    const { stage, callSizes, updates } = makeStage(
      [messageRow('fine'), messageRow('poison'), messageRow('also fine')],
      {
        respond: (input) => {
          if (input.length > 1) {
            throw new Error('null value in column "content" violates not-null constraint');
          }

          if (input[0].content === 'poison') {
            throw new Error('null value in column "content" violates not-null constraint');
          }

          return input.map(() => ({ inserted: true }));
        },
      },
    );

    await stage.run(context);

    // One batched attempt, then one call per row.
    expect(callSizes).toEqual([3, 1, 1, 1]);

    const pushed = updates.find((update) => update.sql.includes("push_status = 'pushed'"));
    const failed = updates.find((update) => update.sql.includes("push_status = 'failed'"));

    expect(pushed?.params[0]).toHaveLength(2);
    expect(failed?.params).toHaveLength(2);
    expect(String(failed?.params[1])).toContain('violates not-null constraint');
  });
});

/*
 * Regression (defect F2): the per-row RETRY decided correspondents differently
 * from the batch it was retrying.
 *
 * `sendMany` threads `selfEntityId` into `resolveCorrespondents`; `send` passed
 * a hard-coded `null`. With null, an outbound message gets no `from` at all —
 * the owner is who sent it, and that is the only thing an outbound chat message
 * ever knows — and `stripSelf` has nothing to strip, so the owner's own entity
 * stays in `to_entity_ids` as one of its own recipients. A batch that happened
 * to fail once therefore wrote quietly different rows from one that did not,
 * and the difference was invisible: both paths report success.
 */
describe('the per-row retry resolves correspondents the same way the batch does', () => {
  const SELF = '99999999-9999-4999-8999-999999999999';
  const CONTACT = '88888888-8888-4888-8888-888888888888';

  const outboundMessage = (n: number) =>
    messageRow(`m${n}`, {
      dataSource: 'imessage',
      metadata: { Source: 'iMessage', 'From Me': true, Text: `m${n}` },
    } as Partial<StagedItem>);

  it('names the owner as sender and strips it from the recipients', async () => {
    const rows = [outboundMessage(1), outboundMessage(2)];
    const { stage, callSizes, sent } = makeStage(rows, {
      selfEntityId: SELF,
      // Both the counterpart and the owner are staged as participants — the
      // shape a group chat produces once outbound edges are staged at all.
      relationships: rows.flatMap((row) => [
        { item_id: row.id, relation: 'participant', server_entity_id: CONTACT },
        { item_id: row.id, relation: 'participant', server_entity_id: SELF },
      ]),
      respond: (input) => {
        if (input.length > 1) {
          throw new Error('null value in column "content" violates not-null constraint');
        }

        return input.map(() => ({ inserted: true }));
      },
    });

    await stage.run(context);

    // One batched attempt, then one call per row: these assertions are about
    // the RETRY path, so the batch must actually have failed.
    expect(callSizes).toEqual([2, 1, 1]);

    // `sent` only records inputs the service accepted, and the batched call
    // threw before recording anything — so everything here came from the retry.
    const retried = sent;
    expect(retried).toHaveLength(2);

    for (const input of retried) {
      expect(input.direction).toBe('outbound');
      expect(input.from_entity_id).toBe(SELF);
      expect(input.to_entity_ids).toEqual([CONTACT]);
    }
  });
});
