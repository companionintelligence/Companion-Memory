import { countAffected } from './countAffected';

const SQL = 'WITH moved AS (UPDATE t SET x = 1 RETURNING 1) SELECT count(*)::int AS count FROM moved';

function runnerReturning(result: unknown) {
  const query = jest.fn(async () => result);

  return { runner: { query } as never, query };
}

describe('countAffected', () => {
  it("returns the counting CTE's count and forwards the statement untouched", async () => {
    const { runner, query } = runnerReturning([{ count: 7 }]);

    await expect(countAffected(runner, SQL, ['a', 1])).resolves.toBe(7);
    expect(query).toHaveBeenCalledWith(SQL, ['a', 1]);
  });

  it('reads an unadorned count(*), which the driver hands back as a bigint string', async () => {
    const { runner } = runnerReturning([{ count: '12' }]);

    await expect(countAffected(runner, SQL, [])).resolves.toBe(12);
  });

  it('reports zero when the write touched nothing', async () => {
    const { runner } = runnerReturning([{ count: 0 }]);

    await expect(countAffected(runner, SQL, [])).resolves.toBe(0);
  });

  it('throws on the [rows, rowCount] pair TypeORM returns for a bare UPDATE/DELETE … RETURNING', async () => {
    // What `….length` used to count: 2 whatever the statement touched.
    const { runner } = runnerReturning([[{ '?column?': 1 }], 1]);

    await expect(countAffected(runner, 'UPDATE t SET x = 1 RETURNING 1', [])).rejects.toThrow(
      /exactly one row with an integer `count`/,
    );
  });

  it('throws rather than reading a missing or malformed count as zero', async () => {
    for (const result of [
      [],
      [{ total: 3 }],
      [{ count: 1 }, { count: 2 }],
      [{ count: 1.5 }],
      [{ count: -1 }],
    ]) {
      const { runner } = runnerReturning(result);

      await expect(countAffected(runner, SQL, [])).rejects.toThrow(/count/);
    }
  });
});
