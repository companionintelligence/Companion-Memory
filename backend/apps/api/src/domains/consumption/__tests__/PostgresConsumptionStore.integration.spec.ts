import { DataSource } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { PostgresConsumptionStore } from '../PostgresConsumptionStore';

import { itBehavesLikeAConsumptionStore } from './consumptionStore.contract';

/**
 * The same contract, against a real Postgres.
 *
 * ═══ WHY THIS PROBES FOR A RELATION AND NOT JUST A PORT ═══
 *
 * `databaseAvailability` answers "is something listening", which is what D7 in
 * docs/asks-threat-model.md is about: pointing a suite at a database that is up
 * but UNMIGRATED produces hard failures reading `relation ... does not exist`,
 * not skips, and they look like the change under test is broken. The extra
 * `to_regclass` check below is the D7 fix applied at least here, so this suite
 * skips with a reason that names the missing migration instead.
 */
const DB_OPTIONS = { urlEnvVar: 'ASKS_TEST_DATABASE_URL' };
const availability = databaseAvailability(DB_OPTIONS);

let dataSource: DataSource | null = null;
let migrated = false;
let counter = 0;

const logger = { setContext: () => {}, warn: () => {}, log: () => {}, debug: () => {} } as never;

beforeAll(async () => {
  const c = availability.available ? resolveConnection(DB_OPTIONS) : null;

  if (c == null) {
    return;
  }

  dataSource = new DataSource(
    c.url != null
      ? { type: 'postgres', url: c.url }
      : {
          type: 'postgres',
          host: c.host,
          port: c.port,
          username: c.username,
          password: c.password,
          database: c.database,
        },
  );

  await dataSource.initialize();

  const [{ present }]: { present: string | null }[] = await dataSource.query(
    `SELECT to_regclass('ci.consumption_windows')::text AS present`,
  );
  migrated = present != null;

  if (!migrated) {
     
    console.warn(
      'PostgresConsumptionStore spec skipped: ci.consumption_windows is absent — run `yarn migrate` against ASKS_TEST_DATABASE_URL.',
    );
  }
});

afterAll(async () => {
  await dataSource?.destroy();
});

const describeOrSkip = availability.available ? describe : describe.skip;

describeOrSkip('PostgresConsumptionStore', () => {
  itBehavesLikeAConsumptionStore(
    'PostgresConsumptionStore',
    () => {
      if (dataSource == null || !migrated) {
        throw new Error('no migrated database');
      }

      return new PostgresConsumptionStore(dataSource, logger);
    },
    // A unique key per test AND per run: this runs against a shared database,
    // so reusing keys would let one run's state decide another run's result.
    () => `test:${process.pid}:${Date.now()}:${++counter}`,
  );
});
