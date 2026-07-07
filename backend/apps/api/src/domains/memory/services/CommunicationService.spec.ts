import type { UserServiceContext } from '@ci/common/context';

import { CommunicationEntity } from '../entities/CommunicationEntity';
import { CommunicationType } from '../types';

import { CommunicationService } from './CommunicationService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

/**
 * CommunicationEntity's persisted-column count (27), matching
 * repository.metadata.columns.length. At 27 columns computeChunkSize caps the
 * winners INSERT at 1000 rows/chunk — well under the 65535-bind-param ceiling
 * (65535/27 ≈ 2427), which is where the pre-fix single INSERT crashed.
 */
const COMMUNICATION_COLUMN_COUNT = 27;

interface Recorder {
  /** Per-INSERT-chunk row counts for the winners insert, in order. */
  insertChunkSizes: number[];
  /** Per-claim-CTE-chunk row counts (parsed from VALUES tuples), in order. */
  claimChunkSizes: number[];
  /** True once dataSource.transaction ran the callback. */
  transactionRan: boolean;
  /** The rows the claim CTE was asked about, so hydration can echo them back. */
  claimedIds: Set<string>;
}

/**
 * A fake InsertQueryBuilder used by the winners INSERT inside the transaction.
 * Records one entry per execute() so the test can assert chunking.
 */
function makeInsertBuilder(rec: Recorder) {
  const qb: Record<string, unknown> = {};
  let pending: unknown[] = [];
  qb.insert = jest.fn(() => qb);
  qb.into = jest.fn(() => qb);
  qb.values = jest.fn((v: unknown[]) => {
    pending = v;

    return qb;
  });
  qb.execute = jest.fn(async () => {
    rec.insertChunkSizes.push(pending.length);

    return { raw: [] };
  });

  return qb;
}

/**
 * A fake transaction manager: `query` handles the claim CTE (returning a `won`
 * row per input triple so every winner is inserted) and the self-heal UPDATE;
 * `createQueryBuilder` returns the winners insert builder.
 */
function makeManager(rec: Recorder) {
  return {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('communications_source_dedup')) {
        // Claim CTE. Each VALUES tuple binds 6 params:
        // (user_id, source_type, source_system, source_id, communication_id, time).
        const rowCount = params.length / 6;
        rec.claimChunkSizes.push(rowCount);

        const rows: Array<Record<string, unknown>> = [];
        for (let i = 0; i < rowCount; i += 1) {
          const base = i * 6;
          const communicationId = params[base + 4] as string;
          rec.claimedIds.add(communicationId);
          rows.push({
            source_type: params[base + 1],
            source_system: params[base + 2],
            source_id: params[base + 3],
            communication_id: communicationId,
            communication_time: params[base + 5],
            won: true, // every triple is freshly claimed -> a winner to INSERT
          });
        }

        return rows;
      }

      // Self-heal UPDATE (only for losers; none here). No-op.
      return [];
    }),
    createQueryBuilder: jest.fn(() => makeInsertBuilder(rec)),
  };
}

function makeService() {
  const rec: Recorder = {
    insertChunkSizes: [],
    claimChunkSizes: [],
    transactionRan: false,
    claimedIds: new Set(),
  };

  const create = jest.fn((partial: Partial<CommunicationEntity>) =>
    Object.assign(new CommunicationEntity(), partial),
  );

  const save = jest.fn(async (entity: CommunicationEntity) => entity);

  // Hydration read: return a row for every id the transaction touched.
  const hydrationBuilder = () => {
    const qb: Record<string, unknown> = {};
    qb.where = jest.fn(() => qb);
    qb.andWhere = jest.fn(() => qb);
    qb.getMany = jest.fn(async () =>
      [...rec.claimedIds].map((id) => Object.assign(new CommunicationEntity(), { id })),
    );

    return qb;
  };

  const repository = {
    create,
    save,
    metadata: { target: CommunicationEntity, columns: { length: COMMUNICATION_COLUMN_COUNT } },
    createQueryBuilder: jest.fn(() => hydrationBuilder()),
  };

  const dataSource = {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<void>) => {
      rec.transactionRan = true;

      return cb(makeManager(rec));
    }),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new CommunicationService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
  );

  return { service, send, rec, dataSource };
}

const makeInput = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    communication_type: CommunicationType.EMAIL,
    time: new Date('2024-01-01T00:00:00.000Z'),
    content: `body ${i}`,
    direction: 'inbound' as const,
    id: `c-${i}`,
    source_type: 'email',
    source_system: 'gmail',
    source_id: `msg-${i}`,
  }));

describe('CommunicationService bulk createMany', () => {
  it('chunk-safe: a 3000-row bulk create succeeds, split into <=1000-row chunks inside ONE transaction (no 65535 bind-param crash)', async () => {
    const { service, rec, dataSource, send } = makeService();

    const result = await service.createMany(CONTEXT, makeInput(3000));

    // All 3000 rows resolved, in input order.
    expect(result).toHaveLength(3000);
    expect(result[0].id).toBe('c-0');
    expect(result[2999].id).toBe('c-2999');

    // The whole call ran inside exactly ONE dataSource.transaction (atomic).
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(rec.transactionRan).toBe(true);

    // The claim CTE was split so no single VALUES list is unbounded. Each row
    // binds 6 params, so computeChunkSize(6) = min(1000, floor(60000/6)) = 1000
    // rows/chunk: 3000 rows -> 3 claim chunks.
    expect(rec.claimChunkSizes).toEqual([1000, 1000, 1000]);

    // The winners INSERT was split into <=1000-row chunks (27 columns ->
    // computeChunkSize = 1000): 3000 rows -> 3 chunks. Previously ONE 3000-row
    // INSERT bound 3000*27 = 81000 params and crashed past the 65535 limit.
    expect(rec.insertChunkSizes).toEqual([1000, 1000, 1000]);
    for (const size of rec.insertChunkSizes) {
      expect(size * COMMUNICATION_COLUMN_COUNT).toBeLessThan(65535);
    }

    // Bulk path emits no per-row events.
    expect(send).not.toHaveBeenCalled();
  });

  it('dedups on re-send: re-sending the same triples issues the claim CTE again (idempotent) and still chunks safely', async () => {
    const { service, rec } = makeService();

    // First send.
    await service.createMany(CONTEXT, makeInput(1500));
    // Re-send the identical batch (same source triples).
    const rec2 = rec.insertChunkSizes.length;
    await service.createMany(CONTEXT, makeInput(1500));

    // Each call split BOTH the claim CTE and the winners INSERT into 1000 + 500
    // row chunks. (This mock always reports `won`, so both sends insert; the
    // real dedup PK collapses the re-send server-side — the point here is that
    // the chunk loop runs safely on both sends.)
    expect(rec.claimChunkSizes).toEqual([1000, 500, 1000, 500]);
    expect(rec.insertChunkSizes.slice(0, rec2)).toEqual([1000, 500]);
    expect(rec.insertChunkSizes.slice(rec2)).toEqual([1000, 500]);
  });

  it('returns an empty array (and opens no transaction) for empty input', async () => {
    const { service, dataSource } = makeService();

    const result = await service.createMany(CONTEXT, []);

    expect(result).toEqual([]);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
