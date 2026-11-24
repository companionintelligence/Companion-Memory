import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 20261006072819: A PHONE'S OLD `write` KEY IS RAISED TO `full`, AND NOTHING ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deletes now need `full` from an api key. The mobile app has minted its key
 * at `full` since #2661, but a phone that signed in earlier still holds a
 * `write` key and never re-mints it. The migration raises exactly those keys.
 * Each guard is pinned on rows Postgres holds, in one transaction rolled back.
 */

const DATABASE_ENV = {
  urlEnvVar: 'AUTH_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'AUTH_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[auth/legacyMobileKeyCapabilityMigration.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

function migrationUp(): string {
  const file = path.resolve(
    __dirname,
    '../../../../db/postgres/migrations/20261006072819_raise_legacy_mobile_device_keys_to_full.sql',
  );
  const sql = readFileSync(file, 'utf8');
  const up = sql.indexOf('-- migrate:up');
  const down = sql.indexOf('-- migrate:down');

  if (up < 0 || down < 0) {
    throw new Error(`${file} has no migrate:up / migrate:down markers.`);
  }

  return sql.slice(up + '-- migrate:up'.length, down);
}

interface Seed {
  name: string;
  scopes: string[];
  capability: 'read' | 'write' | 'full';
  managedBy: 'connect' | 'sign_in' | null;
  after: 'read' | 'write' | 'full';
}

const SEEDS: Record<string, Seed> = {
  // The phone that signed in before #2661.
  legacyPhone: {
    name: 'Companion mobile · 2026-08-14',
    scopes: [],
    capability: 'write',
    managedBy: null,
    after: 'full',
  },
  // The same phone once sign-in provenance has tagged its key: the migration
  // that tags it runs before this one wherever both ship.
  taggedLegacyPhone: {
    name: 'Companion mobile · 2026-08-13',
    scopes: [],
    capability: 'write',
    managedBy: 'sign_in',
    after: 'full',
  },
  // A connect key is CI-Hub's, whatever it is called.
  connectKey: {
    name: 'Companion mobile · 2026-08-12',
    scopes: [],
    capability: 'write',
    managedBy: 'connect',
    after: 'write',
  },
  // A phone that signed in after it: already full.
  currentPhone: {
    name: 'Companion mobile · 2026-09-20',
    scopes: [],
    capability: 'full',
    managedBy: null,
    after: 'full',
  },
  // The owner deliberately chose read-only; never raised.
  readOnly: {
    name: 'Companion mobile · 2026-08-15',
    scopes: [],
    capability: 'read',
    managedBy: null,
    after: 'read',
  },
  // Keys the owner made for something else stay as they are.
  agentKey: { name: 'Home script', scopes: [], capability: 'write', managedBy: null, after: 'write' },
  nearMiss: {
    name: 'Companion mobile backup',
    scopes: [],
    capability: 'write',
    managedBy: null,
    after: 'write',
  },
  // The app never sends scopes, so a scoped key with that name is not the app's.
  scoped: {
    name: 'Companion mobile · 2026-08-16',
    scopes: ['memory'],
    capability: 'write',
    managedBy: null,
    after: 'write',
  },
};

describeWithDatabase(`legacy mobile key migration (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  const userId = randomUUID();
  const ids = Object.fromEntries(Object.keys(SEEDS).map((key) => [key, randomUUID()]));

  beforeAll(async () => {
    const connection = resolveConnection(DATABASE_ENV);

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    await runner.query('INSERT INTO ci.users (id) VALUES ($1::uuid)', [userId]);

    for (const [key, seed] of Object.entries(SEEDS)) {
      await runner.query(
        `INSERT INTO ci.api_keys (id, name, prefix, hashed_key, scopes, capability, user_id, managed_by)
         VALUES ($1::uuid, $2, $3, $4, $5::text[], $6, $7::uuid, $8)`,
        [
          ids[key],
          seed.name,
          `ci_${key.slice(0, 6)}`,
          `hash-${key}`,
          seed.scopes,
          seed.capability,
          userId,
          seed.managedBy,
        ],
      );
    }
  });

  afterAll(async () => {
    if (runner) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("raises only the phone's own pre-#2661 key, and running it again changes nothing", async () => {
    await runner.query(migrationUp());
    await runner.query(migrationUp());

    const rows = (await runner.query('SELECT id, capability FROM ci.api_keys WHERE user_id = $1::uuid', [
      userId,
    ])) as Array<{ id: string; capability: string }>;
    const keyOf = Object.fromEntries(Object.entries(ids).map(([key, id]) => [id, key]));

    expect(Object.fromEntries(rows.map((row) => [keyOf[row.id], row.capability]))).toEqual(
      Object.fromEntries(Object.entries(SEEDS).map(([key, seed]) => [key, seed.after])),
    );
  });
});
