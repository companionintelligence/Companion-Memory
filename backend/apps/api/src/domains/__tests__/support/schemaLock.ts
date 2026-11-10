/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MUTEX BETWEEN A SUITE THAT ALTERS `ci.*` AND ONE THAT WRITES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Jest runs test FILES in parallel workers, and every DB-backed suite here
 * points at the same database. That is fine for suites that only write rows —
 * they scope themselves to their own user or their own run, and Postgres sorts
 * out the row locks. It is not fine for the two suites that apply a real
 * MIGRATION inside their transaction, because DDL takes `ACCESS EXCLUSIVE` on
 * the tables it alters and that lock conflicts with everything.
 *
 * ## The deadlock this exists to make impossible
 *
 * Observed, not theorised — Postgres's own report, with the relation oids
 * resolved:
 *
 *     Process A waits for AccessExclusiveLock on ci.entities; blocked by B.
 *     Process B waits for RowExclusiveLock on ci.graph_deltas; blocked by A.
 *     Process A: -- migrate:up ... (graphDeltaTrigger.spec)
 *     Process B: DELETE FROM ci.users ... (the import staging harness teardown)
 *
 * `graphDeltaTrigger.spec` applies the graph-deltas migration, so by the time
 * it reaches `CREATE TRIGGER ... ON ci.entities` it already holds
 * `ci.graph_deltas`. The staging harness's teardown deletes that harness user's
 * `ci.entities` rows, which fires the delta trigger and so wants
 * `ci.graph_deltas` — while holding `ci.entities`. Each waits for what the
 * other has, and Postgres kills one of them.
 *
 * WHICH one it kills is scheduling, so the failure lands on a different file
 * every run: `graphDeltaTrigger` here, `gmailStaging` there, `pushStage` the
 * time after. Neither suite is wrong on its own and both pass when run alone,
 * which is exactly why this was read as flakiness for as long as it was.
 *
 * ## The protocol
 *
 * One advisory lock in Postgres, taken in the two modes the problem actually
 * has:
 *
 *  - {@link acquireSchemaDdlLock} — EXCLUSIVE, for a suite that runs DDL
 *    against shared `ci.*` tables. Waits for every writer to finish and keeps
 *    new ones out for as long as the migration is applied.
 *  - {@link acquireSchemaWriteLock} — SHARED, for a suite that commits or
 *    row-locks shared `ci.*` tables. Shared holders do not block each other, so
 *    the normal case stays as parallel as it was; they only ever wait on a DDL
 *    suite.
 *
 * In POSTGRES, not in a module-scoped variable, for the same reason
 * `PipelineControlService` takes its tick lock there: the contending parties
 * are separate processes. A jest worker is a process, so an in-memory guard
 * would be four independent guards guarding nothing.
 *
 * It does NOT coordinate with the developer's own running appliance, which is
 * writing the same tables. Nothing in a test suite can, and it does not need
 * to: the appliance takes no DDL locks, so it can be waited for but not
 * deadlocked with. That is what {@link LOCK_TIMEOUT_MS} is for.
 */
import type { DataSource } from 'typeorm';

/**
 * The one key. Arbitrary, fixed, and shared by every caller — two keys would be
 * two mutexes, which is no mutex at all.
 *
 * Advisory locks live in a namespace of their own, so this cannot collide with
 * a table lock; it can only collide with another advisory lock using the same
 * number. `PipelineControlService`'s tick lock is the only other one in the
 * codebase and it derives its key from a different constant.
 */
const SCHEMA_LOCK_KEY = 728_104_512;

/**
 * How long to wait before deciding the holder is stuck rather than busy.
 *
 * Generous: the DDL suites hold this for the length of one migration plus their
 * assertions, and a loaded machine running the full suite is slow. What it
 * rules out is the failure mode where a suite that crashed without releasing
 * leaves every later run hanging with no output at all — a test run that hangs
 * forever is worse than one that fails.
 */
const LOCK_TIMEOUT_MS = 120_000;

/** A held lock. Release it in `afterAll`, always. */
export interface SchemaLock {
  release: () => Promise<void>;
}

async function acquire(
  dataSource: DataSource,
  mode: 'exclusive' | 'shared',
  label: string,
): Promise<SchemaLock> {
  // A DEDICATED connection, never the suite's own. Two reasons, and both have
  // bitten this codebase before: an advisory lock is session-level, so taken on
  // a pooled connection that is handed back it outlives the suite and wedges
  // every later one; and the suite's own runner is usually inside a long
  // transaction that is deliberately rolled back, which must not be able to
  // take the lock with it.
  const runner = dataSource.createQueryRunner();

  await runner.connect();

  try {
    await runner.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);

    const fn = mode === 'exclusive' ? 'pg_advisory_lock' : 'pg_advisory_lock_shared';

    await runner.query(`SELECT ${fn}($1)`, [SCHEMA_LOCK_KEY]);
  } catch (err: unknown) {
    await runner.release();

    throw new Error(
      `${label}: waited ${LOCK_TIMEOUT_MS} ms for the ${mode} ci.* schema test lock and did not get it. ` +
        'Another suite is holding it — most likely one that applies a migration and did not release. ' +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return {
    release: async () => {
      const fn = mode === 'exclusive' ? 'pg_advisory_unlock' : 'pg_advisory_unlock_shared';

      try {
        await runner.query(`SELECT ${fn}($1)`, [SCHEMA_LOCK_KEY]);
      } finally {
        // The release matters more than the unlock: dropping the CONNECTION
        // ends the session, and a session-level advisory lock dies with it. So
        // this runs even if the unlock statement failed.
        await runner.release();
      }
    },
  };
}

/**
 * Exclusive. For a suite that runs DDL against shared `ci.*` tables — i.e. one
 * that applies a migration inside its transaction.
 */
export function acquireSchemaDdlLock(dataSource: DataSource, label: string): Promise<SchemaLock> {
  return acquire(dataSource, 'exclusive', label);
}

/**
 * Shared. For a suite that commits rows to shared `ci.*` tables, or row-locks
 * them inside a transaction it holds open across its tests.
 *
 * Shared holders never block one another, so this costs nothing except while a
 * DDL suite is running.
 */
export function acquireSchemaWriteLock(dataSource: DataSource, label: string): Promise<SchemaLock> {
  return acquire(dataSource, 'shared', label);
}
