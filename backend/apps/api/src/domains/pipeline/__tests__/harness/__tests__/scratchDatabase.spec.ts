import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import {
  ScratchDatabase,
  assertScratchDatabase,
  connectToAdminDatabase,
  scratchDatabaseAvailability,
} from '../scratchDatabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GUARD, exercised.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `enrichmentLoop.integration.spec.ts` writes `ci.events` and `ci.inventory`
 * through two real declared stages, and the only thing standing between that
 * and somebody's personal archive is
 * {@link import('../scratchDatabase').assertScratchDatabase}. It is called
 * before every block of work in that file, and in a healthy run it passes every
 * time — which means a healthy run never demonstrates that it can fail.
 *
 * A guard nobody has watched fail is a guard nobody knows is wired up. That is
 * how this subsystem got here: the file this replaces asserted its own safety
 * in a docblock, and the assertion was false for months. So each of the four
 * facts the guard checks gets a test that makes it false on purpose, including
 * the one that matters most — a connection to a database that exists, has rows,
 * and was not created by this run.
 */

const availability = scratchDatabaseAvailability();

const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[scratchDatabase] SKIPPED — ${availability.reason}`);
}

// Creating a database and applying the migration set. Well under a minute in
// practice; the default 5 s is not a budget worth having a flake over.
jest.setTimeout(300_000);

describeWithDatabase(`the scratch database guard (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'scratchDatabase.spec' });
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('creates a database with a disposable name and this repo’s migrations in it', async () => {
    expect(scratch.name).toMatch(/^ci_pipeline_scratch_\d{14}_[0-9a-f]{8}$/);
    expect(scratch.stats.migrations).toBeGreaterThan(100);

    // The control plane and both stage targets: what the loop suite needs, and
    // proof the migrations really ran rather than merely not throwing.
    const [present] = (await scratch.dataSource.query(
      `SELECT to_regclass('ci.pipeline_state')::text  AS ledger,
              to_regclass('ci.pipeline_runs')::text   AS runs,
              to_regclass('ci.pipeline_shards')::text AS shards,
              to_regclass('ci.events')::text          AS events,
              to_regclass('ci.inventory')::text       AS inventory`,
    )) as Array<Record<string, string | null>>;

    expect(present).toEqual({
      ledger: 'ci.pipeline_state',
      runs: 'ci.pipeline_runs',
      shards: 'ci.pipeline_shards',
      events: 'ci.events',
      inventory: 'ci.inventory',
    });

    // And it is EMPTY. The corpus the loop suite drives is one it seeds itself;
    // if this were ever non-zero, something copied a template it should not have.
    const [rows] = (await scratch.dataSource.query(
      `SELECT (SELECT count(*) FROM ci.events)::int AS events,
              (SELECT count(*) FROM ci.users)::int  AS users`,
    )) as Array<{ events: number; users: number }>;

    expect(rows).toEqual({ events: 0, users: 0 });
  });

  it('passes for the database this run created', async () => {
    await expect(scratch.assertOwn()).resolves.toBeUndefined();
  });

  it('REFUSES a database it did not create — the appliance case', async () => {
    // The maintenance database is a real one, with real rows, reachable on the
    // same connection. This is the shape of the accident: a suite that believes
    // it is isolated, holding a handle to somebody's data.
    const elsewhere: DataSource = connectToAdminDatabase();

    await elsewhere.initialize();

    try {
      const [row] = (await elsewhere.query(`SELECT current_database() AS database`)) as Array<{
        database: string;
      }>;

      // Two ways of being wrong, and the guard has to catch both. First: the
      // expectation still names the scratch database, so the names disagree.
      await expect(
        assertScratchDatabase(elsewhere, { name: scratch.name, token: scratch.token }),
      ).rejects.toThrow(/REFUSING TO RUN/);

      // Second, and the one a naive guard misses: a caller that derived its
      // "expected" name from the connection itself, so the two agree and the
      // comparison is vacuous. The pattern check is what catches it.
      await expect(
        assertScratchDatabase(elsewhere, { name: row.database, token: scratch.token }),
      ).rejects.toThrow(/is not a scratch database name/);
    } finally {
      await elsewhere.destroy();
    }
  });

  it('REFUSES a scratch database belonging to a different run', async () => {
    // A leftover from a killed run: right name shape, right marker table, wrong
    // token. It is still a database with somebody else's rows in it.
    await expect(
      assertScratchDatabase(scratch.dataSource, { name: scratch.name, token: randomUUID() }),
    ).rejects.toThrow(/does not carry this run's token/);
  });

  it('REFUSES a database with no marker in it', async () => {
    // The marker is dropped rather than faked, because "a database named like
    // ours that we did not create" is exactly the case that has to fail and the
    // only honest way to produce it is to remove the thing that identifies us.
    await scratch.dataSource.query(`ALTER SCHEMA pipeline_scratch RENAME TO pipeline_scratch_hidden`);

    try {
      await expect(scratch.assertOwn()).rejects.toThrow(/was not created by this harness/);
    } finally {
      await scratch.dataSource.query(`ALTER SCHEMA pipeline_scratch_hidden RENAME TO pipeline_scratch`);
    }

    // Put back, so `drop()` in afterAll can satisfy its own guard.
    await expect(scratch.assertOwn()).resolves.toBeUndefined();
  });

  it('drops the database, and drop is idempotent', async () => {
    expect(await scratch.exists()).toBe(true);

    await scratch.drop();

    expect(await scratch.exists()).toBe(false);

    // The afterAll calls it again. A second drop must be a no-op rather than an
    // error, or a passing suite ends with a red teardown.
    await expect(scratch.drop()).resolves.toBeUndefined();
  });
});
