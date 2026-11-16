import type { DataSource, EntityManager } from 'typeorm';

import { PgErrorCode } from '@ci/common/constants';

import { compressPositionChunk, createPositionChunks, decompressPositionChunk } from '../positionChunks';

/**
 * The retry in `positionChunks.ts` may only ever run a cancelled deadlock
 * victim again. Anything else has to reach the suite as it was thrown, and the
 * retry has to stop. No database is needed: the data source is a fake that
 * records each statement and fails the transactions it is told to.
 */

const CHUNK = '_timescaledb_internal._hyper_1_2_chunk';

function deadlock(where: 'code' | 'driverError'): Error {
  const err = new Error('deadlock detected');

  return where === 'code'
    ? Object.assign(err, { code: PgErrorCode.DEADLOCK_DETECTED })
    : Object.assign(err, { driverError: { code: PgErrorCode.DEADLOCK_DETECTED } });
}

/**
 * A data source whose transaction number `n` (from 1) throws `failures[n - 1]`
 * after its first statement, when there is one. `missingDays` is what the
 * "days without a chunk" read outside the transaction returns.
 */
function fakeDataSource(failures: Array<Error | undefined>, missingDays: unknown[] = []) {
  const transactions: string[][] = [];

  const dataSource = {
    query: jest.fn(async () => missingDays),
    transaction: jest.fn(async (work: (manager: EntityManager) => Promise<void>) => {
      const statements: string[] = [];
      const failure = failures[transactions.length];

      transactions.push(statements);

      const manager = {
        query: jest.fn(async (sql: string) => {
          statements.push(sql);

          if (failure && statements.length === 1) {
            throw failure;
          }

          if (sql.includes('format(')) {
            return [{ lock: `LOCK TABLE ONLY ci.position, ONLY ${CHUNK} IN SHARE MODE` }];
          }

          return sql.startsWith('INSERT') ? [{ time: '1985-01-15 00:00:00+00' }] : [];
        }),
      } as unknown as EntityManager;

      await work(manager);
    }),
  };

  return { dataSource: dataSource as unknown as DataSource, transactions, outer: dataSource };
}

describe('positionChunks', () => {
  it.each(['code', 'driverError'] as const)(
    'runs a compress again when Postgres cancels it as a deadlock victim (error %s)',
    async (where) => {
      const { dataSource, transactions } = fakeDataSource([deadlock(where)]);

      await compressPositionChunk(dataSource, CHUNK);

      expect(transactions).toHaveLength(2);
      expect(transactions[1]).toEqual([
        expect.stringContaining('format('),
        `LOCK TABLE ONLY ci.position, ONLY ${CHUNK} IN SHARE MODE`,
        expect.stringContaining('compress_chunk('),
      ]);
    },
  );

  it('stops after three attempts and throws the last deadlock', async () => {
    const last = deadlock('code');
    const { dataSource, transactions } = fakeDataSource([deadlock('code'), deadlock('code'), last]);

    await expect(decompressPositionChunk(dataSource, CHUNK)).rejects.toBe(last);
    expect(transactions).toHaveLength(3);
  });

  it('does not run anything else again', async () => {
    const duplicate = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const { dataSource, transactions } = fakeDataSource([duplicate]);

    await expect(compressPositionChunk(dataSource, CHUNK)).rejects.toBe(duplicate);
    expect(transactions).toHaveLength(1);
  });

  it('takes no lock when every chunk in the range already exists', async () => {
    const { dataSource, outer } = fakeDataSource([], []);

    await createPositionChunks(dataSource, 'user-1', '1985-01-15T00:00:00Z', '1985-01-15T05:00:00Z');

    expect(outer.query).toHaveBeenCalledTimes(1);
    expect(outer.transaction).not.toHaveBeenCalled();
  });

  it('locks ci.users first, then writes and deletes only the rows it wrote', async () => {
    const { dataSource, transactions } = fakeDataSource([deadlock('code')], [{ t: '1985-01-15' }]);

    await createPositionChunks(dataSource, 'user-1', '1985-01-15T00:00:00Z', '1985-01-15T05:00:00Z');

    expect(transactions).toHaveLength(2);
    expect(transactions[1]).toEqual([
      expect.stringMatching(/^LOCK TABLE ci\.users, /),
      expect.stringMatching(/^\s*INSERT INTO ci\.position/),
      expect.stringMatching(/^DELETE FROM ci\.position WHERE user_id = \$1 AND time = ANY/),
    ]);
  });
});
