import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { DataSource } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { v7 as uuidv7 } from 'uuid';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';

const API_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Both the step and the check run under plain Node, the way `dbmate up` runs in
 * the image. pg-boss 12 is an ES module, which Node 22 can `require` and jest's
 * own module loader refuses.
 */
function node(script: string, url: string): string {
  const wrapped = `(async () => { ${script} })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`;

  return execFileSync(process.execPath, ['-e', wrapped, '--', url], {
    cwd: API_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function upgradePgBossSchema(url: string): void {
  node(`await require('./bin/upgrade-pgboss-schema').upgradePgBossSchema(process.argv[1]);`, url);
}

/** Starts the pg-boss this build ships and returns the ids it hands a worker from the `default` queue. */
function fetchWithPgBoss(url: string): string[] {
  const output = node(
    `const { PgBoss } = require('pg-boss');
     const boss = new PgBoss({ connectionString: process.argv[1], schema: 'pgboss', schedule: false, supervise: false });
     boss.on('error', (e) => { console.error(e); process.exit(1); });
     await boss.start();
     const jobs = await boss.fetch('default', { batchSize: 10 });
     await boss.stop({ graceful: false });
     console.log(JSON.stringify(jobs.map((j) => j.id)));`,
    url,
  );

  return JSON.parse(output.trim().split('\n').at(-1) ?? '[]') as string[];
}

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[events/upgradePgBossSchema] SKIPPED — ${availability.reason}`);
}

// CREATE DATABASE plus every migration.
jest.setTimeout(300_000);

/** The tables pg-boss 10.3.2 builds that the upgrade reads, at the schema version it leaves. */
const PGBOSS_10_DDL = `
  CREATE TYPE pgboss.job_state AS ENUM ('created', 'retry', 'active', 'completed', 'cancelled', 'failed');

  CREATE TABLE pgboss.version (version int PRIMARY KEY, maintained_on timestamptz, cron_on timestamptz, monitored_on timestamptz);
  INSERT INTO pgboss.version (version) VALUES (24);

  CREATE TABLE pgboss.queue (
    name text PRIMARY KEY,
    policy text,
    retry_limit int,
    retry_delay int,
    retry_backoff bool,
    expire_seconds int,
    retention_minutes int,
    dead_letter text REFERENCES pgboss.queue (name),
    partition_name text,
    created_on timestamptz NOT NULL DEFAULT now(),
    updated_on timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE pgboss.job (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    priority integer NOT NULL DEFAULT 0,
    data jsonb,
    state pgboss.job_state NOT NULL DEFAULT 'created',
    retry_limit integer NOT NULL DEFAULT 2,
    retry_count integer NOT NULL DEFAULT 0,
    retry_delay integer NOT NULL DEFAULT 0,
    retry_backoff boolean NOT NULL DEFAULT false,
    start_after timestamptz NOT NULL DEFAULT now(),
    started_on timestamptz,
    singleton_key text,
    singleton_on timestamp,
    expire_in interval NOT NULL DEFAULT interval '15 minutes',
    created_on timestamptz NOT NULL DEFAULT now(),
    completed_on timestamptz,
    keep_until timestamptz NOT NULL DEFAULT now() + interval '14 days',
    output jsonb,
    dead_letter text,
    policy text,
    PRIMARY KEY (name, id)
  ) PARTITION BY LIST (name);

  CREATE TABLE pgboss.j_default PARTITION OF pgboss.job FOR VALUES IN ('default');
  CREATE TABLE pgboss.j_dead_letter PARTITION OF pgboss.job FOR VALUES IN ('dead-letter');
  CREATE TABLE pgboss.j_send_it PARTITION OF pgboss.job FOR VALUES IN ('__pgboss__send-it');

  CREATE TABLE pgboss.archive (LIKE pgboss.job);

  INSERT INTO pgboss.queue (name, policy) VALUES ('dead-letter', 'standard'), ('__pgboss__send-it', 'standard');
  INSERT INTO pgboss.queue (name, policy, dead_letter) VALUES ('default', 'standard', 'dead-letter');
`;

describeWithDatabase(`upgradePgBossSchema — against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let url: string;

  async function seedJob(
    state: string,
    columns: Record<string, unknown> = {},
    queue = 'default',
  ): Promise<string> {
    const id = uuidv7();
    const all: Record<string, unknown> = {
      id,
      name: queue,
      state,
      data: { name: 'test.event', id },
      ...columns,
    };
    const names = Object.keys(all);

    await dataSource.query(
      `INSERT INTO pgboss.job (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(all),
    );

    return id;
  }

  async function job(id: string): Promise<Record<string, unknown>> {
    const rows = await dataSource.query<Array<Record<string, unknown>>>(
      'SELECT * FROM pgboss.job WHERE id = $1',
      [id],
    );

    expect(rows).toHaveLength(1);

    return rows[0];
  }

  async function exists(sql: string): Promise<boolean> {
    const rows = await dataSource.query<Array<{ found: boolean }>>(`SELECT ${sql} AS found`);

    return rows[0].found;
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'upgradePgBossSchema.integration.spec' });
    await scratch.assertOwn();
    dataSource = scratch.dataSource;

    const { host, port, username, password, database } = dataSource.options as PostgresDataSourceOptions;

    url = `postgres://${encodeURIComponent(String(username))}:${encodeURIComponent(String(password))}@${host}:${port}/${database}`;
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await dataSource.query(
      'DROP SCHEMA IF EXISTS pgboss_v10 CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA pgboss;',
    );
  });

  it('moves a pg-boss 10 queue so pg-boss 12 starts and runs the waiting jobs', async () => {
    await dataSource.query(PGBOSS_10_DDL);

    const later = new Date(Date.now() + 3_600_000);
    const waiting = await seedJob('created', { priority: 3, retry_limit: 5, singleton_key: 'k1' });
    const delayed = await seedJob('created', { start_after: later, expire_in: '1 hour' });
    const retrying = await seedJob('retry', { retry_count: 1 });
    const interrupted = await seedJob('active', { started_on: new Date(), retry_count: 2 });
    const failed = await seedJob('failed', { completed_on: new Date(), output: { message: 'boom' } });
    const lettered = await seedJob('created', {}, 'dead-letter');
    const cron = await seedJob('created', {}, '__pgboss__send-it');

    upgradePgBossSchema(url);

    expect(await exists(`to_regnamespace('pgboss_v10') IS NULL`)).toBe(true);

    const [{ version }] = await dataSource.query<Array<{ version: number }>>(
      'SELECT version FROM pgboss.version',
    );

    expect(version).toBeGreaterThanOrEqual(25);

    expect(await job(waiting)).toMatchObject({
      state: 'created',
      priority: 3,
      retry_limit: 5,
      singleton_key: 'k1',
    });
    expect(await job(delayed)).toMatchObject({ state: 'created', start_after: later, expire_seconds: 3600 });
    expect(await job(retrying)).toMatchObject({ state: 'retry', retry_count: 1 });
    expect(await job(interrupted)).toMatchObject({ state: 'retry', retry_count: 2, started_on: null });
    expect(await job(failed)).toMatchObject({ state: 'failed', output: { message: 'boom' } });
    expect(await job(lettered)).toMatchObject({ state: 'created' });

    expect(await dataSource.query('SELECT 1 FROM pgboss.job WHERE id = $1', [cron])).toHaveLength(0);
    expect(await dataSource.query(`SELECT 1 FROM pgboss.queue WHERE name LIKE '\\_\\_pgboss%'`)).toHaveLength(
      0,
    );

    const [queue] = await dataSource.query<Array<{ policy: string; dead_letter: string }>>(
      `SELECT policy, dead_letter FROM pgboss.queue WHERE name = 'default'`,
    );

    expect(queue).toEqual({ policy: 'standard', dead_letter: 'dead-letter' });

    expect(fetchWithPgBoss(url).sort()).toEqual([waiting, retrying, interrupted].sort());
  });

  it('leaves a database alone when pg-boss has never booted on it', async () => {
    upgradePgBossSchema(url);

    expect(await exists(`to_regclass('pgboss.version') IS NULL`)).toBe(true);
    expect(await exists(`to_regnamespace('pgboss_v10') IS NULL`)).toBe(true);
  });

  it('does nothing on a second run', async () => {
    await dataSource.query(PGBOSS_10_DDL);
    const id = await seedJob('created');

    upgradePgBossSchema(url);
    upgradePgBossSchema(url);

    await job(id);
  });

  it('finishes the move when an earlier run died after renaming the schema', async () => {
    await dataSource.query(PGBOSS_10_DDL);
    const id = await seedJob('created');

    await dataSource.query('ALTER SCHEMA pgboss RENAME TO pgboss_v10');

    upgradePgBossSchema(url);

    expect(await job(id)).toMatchObject({ state: 'created' });
    expect(await exists(`to_regnamespace('pgboss_v10') IS NULL`)).toBe(true);
  });
});
