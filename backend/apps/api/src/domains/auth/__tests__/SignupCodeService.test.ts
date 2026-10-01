import { SignupCodeService } from '../services/SignupCodeService';

/**
 * The command TypeORM's Postgres driver keys the shape of a `query()` result on: the OUTER one. A
 * leading `WITH` is skipped, so `WITH x AS (UPDATE ...) SELECT ...` is a SELECT.
 */
function outerCommand(sql: string): string {
  let rest = sql.trim();

  if (/^with\s/i.test(rest)) {
    rest = rest.replace(/^with\s+(recursive\s+)?/i, '');

    // Past each `name AS (...)` by paren depth, and the commas between them.
    for (;;) {
      let depth = 0;
      let index = rest.indexOf('(');

      for (; index < rest.length; index += 1) {
        if (rest[index] === '(') {
          depth += 1;
        } else if (rest[index] === ')' && --depth === 0) {
          break;
        }
      }

      rest = rest.slice(index + 1).trim();

      if (!rest.startsWith(',')) {
        break;
      }

      rest = rest.slice(1).trim();
    }
  }

  return rest.split(/\s+/, 1)[0].toUpperCase();
}

/**
 * What the driver resolves a statement that produced `rows` to: `[rows, rowCount]` for an outer
 * UPDATE or DELETE (typeorm `PostgresQueryRunner.query`), the rows themselves for anything else.
 * Measured against Postgres in `EstimateLocationStage.spec.ts`; a fake that answered a bare UPDATE
 * with plain rows is how `UPDATE ... RETURNING` misreads went unnoticed in several services.
 */
function driverResult(sql: string, rows: unknown[]): unknown {
  return ['UPDATE', 'DELETE'].includes(outerCommand(sql)) ? [rows, rows.length] : rows;
}

/** A transaction whose redeeming statement finds `matched` unused rows, answered in the driver's shape. */
function fakeTransaction(matched: number) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  return {
    statements,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });

      return driverResult(
        sql,
        Array.from({ length: matched }, (_row, index) => ({ id: String(index + 1) })),
      );
    }),
  };
}

function makeService() {
  const connection = fakeTransaction(1);
  const service = new SignupCodeService({ manager: connection } as never);

  return { service, connection };
}

describe('SignupCodeService.consume', () => {
  it('tells the caller it redeemed the code when the statement changed its row', async () => {
    const { service } = makeService();

    expect(await service.consume('abc123', fakeTransaction(1) as never)).toBe(true);
  });

  it('tells the caller it did not when the statement changed nothing — used, unknown, or redeemed first elsewhere', async () => {
    // With a bare UPDATE ... RETURNING the driver hands back [rows, rowCount], whose length is 2 even
    // when nothing matched; this is the case that would then admit everybody.
    const { service } = makeService();

    expect(await service.consume('abc123', fakeTransaction(0) as never)).toBe(false);
  });

  it('decides in ONE statement, and only for a code that is still unused', async () => {
    const { service } = makeService();
    const transaction = fakeTransaction(1);

    await service.consume('abc123', transaction as never);

    expect(transaction.statements).toHaveLength(1);

    const [{ sql, params }] = transaction.statements;

    expect(sql).toMatch(
      /UPDATE ci\.signup_code\s+SET used = true\s+WHERE signup_code = \$1\s+AND used = false/,
    );
    expect(params).toEqual(['abc123']);
    // A SELECT on the outside, so the result is the rows and not the driver's pair.
    expect(outerCommand(sql)).toBe('SELECT');
  });

  it('redeems in the transaction it is given, so the redemption commits or rolls back with it', async () => {
    const { service, connection } = makeService();
    const transaction = fakeTransaction(1);

    await service.consume('abc123', transaction as never);

    expect(transaction.query).toHaveBeenCalledTimes(1);
    expect(connection.query).not.toHaveBeenCalled();
  });

  it('commits on its own when it is given no transaction', async () => {
    const { service, connection } = makeService();

    expect(await service.consume('abc123')).toBe(true);
    expect(connection.query).toHaveBeenCalledTimes(1);
  });
});

describe('the driver-shaped fake this suite answers with', () => {
  it('answers a bare UPDATE with the pair, and a statement a CTE turns into a SELECT with the rows', () => {
    const rows = [{ id: '1' }];

    expect(driverResult('UPDATE ci.signup_code SET used = true RETURNING id', rows)).toEqual([rows, 1]);
    expect(
      driverResult(
        'WITH redeemed AS (UPDATE ci.signup_code SET used = true RETURNING id) SELECT id FROM redeemed',
        rows,
      ),
    ).toBe(rows);
    expect(driverResult('WITH a AS (SELECT 1), b AS (SELECT (2)) DELETE FROM ci.signup_code', rows)).toEqual([
      rows,
      1,
    ]);
  });
});
