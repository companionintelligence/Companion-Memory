/**
 * Shared spec harness: a mocked TypeORM insert query builder that records what
 * a chunked `.insert().into().values().onConflict().execute()` chain wrote, so
 * specs can assert on the rows and the conflict clause without a database.
 *
 * One canonical copy — the memory service specs all stub the same chain, and
 * a change to it (e.g. migrating off the deprecated `onConflict`) must land in
 * one place.
 */
export interface InsertRecord {
  /** The rows handed to the most recent `.values()` call. */
  values?: unknown[];
  /** The clause handed to the most recent `.onConflict()` call. */
  conflict?: string;
  /** Set to true once `.execute()` runs. */
  inserted?: boolean;
  /** Per-`.execute()` row counts; seed with `[]` to collect chunk sizes. */
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
  qb.onConflict = jest.fn((c: string) => {
    record.conflict = c;

    return qb;
  });
  qb.execute = jest.fn(async () => {
    record.inserted = true;
    record.chunkSizes?.push(pending.length);

    return { raw: [] };
  });

  return qb;
}
