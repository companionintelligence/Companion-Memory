/**
 * Shared spec harness: a mocked TypeORM insert query builder that records what
 * a chunked `.insert().into().values()` + raw `ON CONFLICT` insert wrote, so
 * specs can assert on the rows and the conflict clause without a database.
 *
 * One canonical copy — the memory service specs all stub the same chain, and
 * a change to it must land in one place.
 */
export interface InsertRecord {
  /** The rows handed to the most recent `.values()` call. */
  values?: unknown[];
  /** The clause spliced after `ON CONFLICT` by the most recent insert. */
  conflict?: string;
  /** Set to true once the insert runs. */
  inserted?: boolean;
  /** Per-insert row counts; seed with `[]` to collect chunk sizes. */
  chunkSizes?: number[];
}

export function makeInsertBuilder(record: InsertRecord) {
  const qb: Record<string, unknown> = {};
  let pending: unknown[] = [];
  qb.insert = jest.fn(() => qb);
  qb.into = jest.fn(() => qb);
  qb.values = jest.fn((v: unknown[]) => {
    record.values = v;
    pending = v;

    return qb;
  });
  qb.getQuery = jest.fn(() => 'INSERT INTO "t" ("id") VALUES ($1)');
  qb.getParameters = jest.fn(() => ({}));
  qb.connection = {
    driver: {
      escapeQueryWithParameters: jest.fn((sql: string) => [sql, []]),
    },
  };
  qb.queryRunner = {
    query: jest.fn(async (sql: string) => {
      const at = sql.indexOf(' ON CONFLICT ');
      record.conflict = at === -1 ? undefined : sql.slice(at + ' ON CONFLICT '.length);
      record.inserted = true;
      record.chunkSizes?.push(pending.length);

      return [];
    }),
  };

  return qb;
}
