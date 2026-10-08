import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 20261006071435: CHAT-AGENT KEYS ALREADY MINTED GET THE NEW JOB SCOPE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/v1/agent/jobs` moved from `memory` to its own `agent-jobs` scope. A key
 * CI-OpenClaw already holds says `{memory,intents,mcp}`, and CI-Hub would not
 * rotate it for up to 60 days, so without this migration dispatch stops on
 * upgrade. Each guard is pinned on rows Postgres holds, inside one
 * transaction that is rolled back.
 */

const DATABASE_ENV = {
  urlEnvVar: 'AUTH_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'AUTH_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[auth/agentJobsScopeMigration.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const MIGRATION = path.resolve(
  __dirname,
  '../../../../db/postgres/migrations/20261006071435_grant_agent_jobs_scope_to_chat_agent_keys.sql',
);

function migrationHalf(half: 'up' | 'down'): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const up = sql.indexOf('-- migrate:up');
  const down = sql.indexOf('-- migrate:down');

  if (up < 0 || down < 0) {
    throw new Error(`${MIGRATION} has no migrate:up / migrate:down markers.`);
  }

  return half === 'up'
    ? sql.slice(up + '-- migrate:up'.length, down)
    : sql.slice(down + '-- migrate:down'.length);
}

interface Seed {
  name: string;
  managedBy: 'connect' | null;
  scopes: string[];
  after: string[];
}

const SEEDS: Record<string, Seed> = {
  openclaw: {
    name: 'app:ci-openclaw:ci-marketplace',
    managedBy: 'connect',
    scopes: ['memory', 'intents', 'mcp'],
    after: ['memory', 'intents', 'mcp', 'agent-jobs'],
  },
  hermes: {
    name: 'app:ci-hermes:ci-marketplace',
    managedBy: 'connect',
    scopes: ['memory', 'intents', 'mcp'],
    after: ['memory', 'intents', 'mcp', 'agent-jobs'],
  },
  // Already migrated, or minted by the new code: not appended twice.
  openclawNew: {
    name: 'app:ci-openclaw:other-store',
    managedBy: 'connect',
    scopes: ['memory', 'intents', 'mcp', 'agent-jobs'],
    after: ['memory', 'intents', 'mcp', 'agent-jobs'],
  },
  // Memory-only apps lose the job routes, which is the point.
  voice: {
    name: 'app:ci-ha-voice:ci-marketplace',
    managedBy: 'connect',
    scopes: ['memory'],
    after: ['memory'],
  },
  unreviewed: {
    name: 'app:hermes-agent:ci-marketplace',
    managedBy: 'connect',
    scopes: ['memory', 'intents', 'mcp'],
    after: ['memory', 'intents', 'mcp'],
  },
  // A user's hand-made key carrying a connect-looking name is never touched.
  handMade: {
    name: 'app:ci-openclaw:kitchen',
    managedBy: null,
    scopes: ['memory', 'intents', 'mcp'],
    after: ['memory', 'intents', 'mcp'],
  },
  // An empty scope set already reaches every route; appending would confine it.
  unscoped: {
    name: 'app:ci-openclaw:legacy',
    managedBy: 'connect',
    scopes: [],
    after: [],
  },
};

describeWithDatabase(`agent-jobs scope migration (${availability.target})`, () => {
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
        `INSERT INTO ci.api_keys (id, name, prefix, hashed_key, scopes, user_id, managed_by)
         VALUES ($1::uuid, $2, $3, $4, $5::text[], $6::uuid, $7)`,
        [ids[key], seed.name, `ci_${key.slice(0, 6)}`, `hash-${key}`, seed.scopes, userId, seed.managedBy],
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

  const scopesNow = async (): Promise<Record<string, string[]>> => {
    const rows = (await runner.query('SELECT id, scopes FROM ci.api_keys WHERE user_id = $1::uuid', [
      userId,
    ])) as Array<{ id: string; scopes: string[] }>;
    const keyOf = Object.fromEntries(Object.entries(ids).map(([key, id]) => [id, key]));

    return Object.fromEntries(rows.map((row) => [keyOf[row.id], row.scopes]));
  };

  it('adds agent-jobs to the chat agents and nothing else, and is idempotent', async () => {
    await runner.query(migrationHalf('up'));
    // dbmate runs it once; a second run must change nothing either.
    await runner.query(migrationHalf('up'));

    expect(await scopesNow()).toEqual(
      Object.fromEntries(Object.entries(SEEDS).map(([key, seed]) => [key, seed.after])),
    );
  });

  it('down removes exactly what up added', async () => {
    await runner.query(migrationHalf('down'));

    const now = await scopesNow();

    expect(now.openclaw).toEqual(['memory', 'intents', 'mcp']);
    expect(now.hermes).toEqual(['memory', 'intents', 'mcp']);
    expect(now.voice).toEqual(['memory']);
    expect(now.handMade).toEqual(['memory', 'intents', 'mcp']);
    expect(now.unscoped).toEqual([]);
  });
});
