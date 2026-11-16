/**
 * Chunk DDL on `ci.position` from parallel suites: two deadlocks that the
 * schema lock (`schemaLock.ts`) cannot prevent. It only keeps out the suites
 * that take it. Some suites delete their user without it.
 *
 * ## Creating a chunk
 *
 * The first row in a chunk's time range (30 days counted from 1970-01-01, not a
 * calendar month) makes TimescaleDB create the chunk and copy the table's
 * foreign keys onto it. That locks `ci.devices`, `ci.entities` and then
 * `ci.users`. A `DELETE FROM ci.users` in another worker takes the user row
 * first and `ci.entities` in its cascade. Postgres's report:
 *
 *     Process A waits for ShareRowExclusiveLock on ci.users; blocked by B.
 *     Process B waits for RowExclusiveLock on ci.entities; blocked by A.
 *     Process A: INSERT INTO ci.position ... (PlaceMergeService.integration)
 *     Process B: DELETE FROM ci.users ... (PersonMergeService.integration teardown)
 *
 * {@link createPositionChunks} creates a suite's missing chunks before its
 * first fix, in a transaction that takes `ci.users` first, the way the delete
 * does. Then one waits for the other instead of the two deadlocking. It
 * takes `ci.devices` and `ci.entities` in that same statement rather than
 * leaving them to the chunk a round trip later. A transaction that writes
 * `ci.entities` and then `ci.users` still meets it in a cycle, but the chunk
 * side is then the one that waited first, so Postgres cancels it and it runs
 * again. When every chunk already exists (any run after the first on the same
 * database) it takes no lock.
 *
 * ## Compressing a chunk
 *
 * `compress_chunk` holds a lock on the chunk and waits for an ACCESS EXCLUSIVE
 * one, while a statement that writes every chunk (that same cascade, a
 * `DELETE FROM ci.position` or a place merge moving fixes) holds a weaker lock
 * on the chunk and waits to write it:
 *
 *     Process A waits for AccessExclusiveLock on <the chunk>; blocked by B.
 *     Process B waits for RowExclusiveLock on <the chunk>; blocked by A.
 *     Process A: SELECT compress_chunk(...)
 *     Process B: DELETE FROM ci.users WHERE id = $1
 *
 * {@link compressPositionChunk} and {@link decompressPositionChunk} first take
 * `ci.position` itself (ONLY the table, not its other chunks) and then the one
 * chunk, both in SHARE mode and in one statement. A statement that writes
 * `ci.position` takes the table before it reaches a chunk, so one waits for
 * the other instead.
 *
 * A cascade does not always. Each chunk carries its own copy of the foreign
 * keys. Postgres fires a table's triggers in name order:
 * `RI_ConstraintTrigger_a_<oid>`, compared as text. Once the OID counter has
 * gained a digit between the migration that built `ci.position` and the chunk
 * (every scratch-database suite runs the whole migration chain, so a full
 * `make test-db` run gets there), `..._a_108128` on the chunk fires before
 * `..._a_25212` on the table. The same goes for the `ON DELETE SET NULL`
 * cascades from `ci.entities` and `ci.devices`. A `DELETE FROM ci.users` then
 * holds the chunk and waits for the table while the compress holds the table
 * and waits for the chunk. Postgres cancels the side that waited first. The
 * compress asks for the chunk in the same statement that got it the table, so
 * that is almost always the compress, and
 * {@link inTransactionRetryingDeadlocks} runs it again. Taking the chunk a
 * statement later (or leaving it to `compress_chunk`) left the cascade time to
 * reach the table first, and then the cancelled statement was the other
 * suite's teardown, which nothing retries.
 */
import type { DataSource, EntityManager } from 'typeorm';

import { PgErrorCode } from '@ci/common/constants';

/** How many times a transaction Postgres cancelled as a deadlock victim runs. */
const DEADLOCK_ATTEMPTS = 3;

/**
 * The days from `from` to `to` (and `to` itself) that no `ci.position` chunk
 * covers yet. `$1` is `from`, `$2` is `to`.
 */
const DAYS_WITHOUT_A_CHUNK = `
  SELECT days.t
    FROM (SELECT generate_series($1::timestamptz, $2::timestamptz, interval '1 day') AS t
          UNION SELECT $2::timestamptz) AS days
   WHERE NOT EXISTS (
           SELECT 1
             FROM timescaledb_information.chunks c
            WHERE c.hypertable_schema = 'ci'
              AND c.hypertable_name = 'position'
              AND days.t >= c.range_start
              AND days.t < c.range_end)`;

/**
 * Creates every `ci.position` chunk between `from` and `to` that does not exist
 * yet, so the suite's own fixes there never create one. It writes a fix for
 * `userId` (who must exist) on each uncovered day, then deletes exactly those
 * rows again. The chunks stay. Call it before the suite's first `ci.position`
 * row, once for each stretch of time the suite writes.
 */
export async function createPositionChunks(
  dataSource: DataSource,
  userId: string,
  from: string,
  to: string,
): Promise<void> {
  const missing: unknown[] = await dataSource.query(DAYS_WITHOUT_A_CHUNK, [from, to]);

  if (missing.length === 0) {
    return;
  }

  await inTransactionRetryingDeadlocks(dataSource, async (manager) => {
    // Every table a new chunk's foreign keys point at, ci.users first.
    await manager.query('LOCK TABLE ci.users, ci.devices, ci.entities IN SHARE ROW EXCLUSIVE MODE');
    // Re-read under the lock: another suite may have created some meanwhile.
    const written: Array<{ time: string }> = await manager.query(
      `INSERT INTO ci.position (time, user_id, source, location)
       SELECT t, $3::uuid, 'gps', ST_SetSRID(ST_MakePoint(0, 0), 4326)
         FROM (${DAYS_WITHOUT_A_CHUNK}) AS missing
       RETURNING time::text AS time`,
      [from, to, userId],
    );
    await manager.query('DELETE FROM ci.position WHERE user_id = $1 AND time = ANY($2::timestamptz[])', [
      userId,
      written.map((row) => row.time),
    ]);
  });
}

/** `compress_chunk` on one `ci.position` chunk, with the table and then the chunk locked first. */
export async function compressPositionChunk(dataSource: DataSource, chunk: string): Promise<void> {
  await withPositionLocked(
    dataSource,
    'SELECT compress_chunk($1::regclass, if_not_compressed => true)',
    chunk,
  );
}

/** `decompress_chunk` on one `ci.position` chunk, with the table and then the chunk locked first. */
export async function decompressPositionChunk(dataSource: DataSource, chunk: string): Promise<void> {
  await withPositionLocked(dataSource, 'SELECT decompress_chunk($1::regclass, if_compressed => true)', chunk);
}

async function withPositionLocked(dataSource: DataSource, sql: string, chunk: string): Promise<void> {
  await inTransactionRetryingDeadlocks(dataSource, async (manager) => {
    // LOCK takes no parameters, so Postgres quotes the chunk's name itself.
    const [{ lock }]: Array<{ lock: string }> = await manager.query(
      `SELECT format('LOCK TABLE ONLY ci.position, ONLY %s IN SHARE MODE', $1::regclass) AS lock`,
      [chunk],
    );
    await manager.query(lock);
    await manager.query(sql, [chunk]);
  });
}

/**
 * Runs `work` in a transaction. When Postgres cancels it to break a deadlock,
 * runs it again, up to {@link DEADLOCK_ATTEMPTS} times in all. The cancelled
 * attempt rolled back whole, so running it again is safe.
 */
async function inTransactionRetryingDeadlocks(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await dataSource.transaction(work);

      return;
    } catch (err) {
      if (attempt >= DEADLOCK_ATTEMPTS || !isDeadlock(err)) {
        throw err;
      }
    }
  }
}

function isDeadlock(err: unknown): boolean {
  const failure = err as { code?: unknown; driverError?: { code?: unknown } } | null;

  return (
    failure?.code === PgErrorCode.DEADLOCK_DETECTED ||
    failure?.driverError?.code === PgErrorCode.DEADLOCK_DETECTED
  );
}
