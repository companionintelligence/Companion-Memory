import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { buildVectorUpsertStatement } from '@ci/domains/search-ingress';
import { DEVICE_RECORD_VERSION } from '@ci/domains/search-next';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';

/**
 * 20261026044030 and 20261027000227: AGENT TURNS STORED FROM THE OWNER'S SIDE,
 * ON THE APPLIANCE AND ON THE PHONE.
 *
 * `POST /memory/turn` used to store the owner's message as `inbound` and the
 * agent's reply as `outbound`. The first migration turns the stored rows round;
 * the second resets the device record of each row whose record still carries
 * the old direction, so MobileSearchDocumentDetailCron re-derives it and
 * PowerSync sends it to the phone. Both run here on rows Postgres holds, in one
 * transaction that is rolled back.
 *
 * Opt-in like the sibling integration specs: set AGENT_TEST_DATABASE_URL to a
 * migrated database of your own, or run `make test-db`.
 */

const DATABASE_ENV = { urlEnvVar: 'AGENT_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[agent/agentTurnDirection.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const MIGRATIONS = path.resolve(__dirname, '../../../../db/postgres/migrations');

function migrationUp(file: string): string {
  const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');

  if (start < 0 || end < 0) {
    throw new Error(`${file} has no migrate:up / migrate:down markers.`);
  }

  return sql.slice(start + '-- migrate:up'.length, end);
}

const FLIP = '20261026044030_flip_agent_turn_direction.sql';
const REFRESH = '20261027000227_refresh_agent_turn_device_records.sql';

type Direction = 'inbound' | 'outbound';

interface Seed {
  category: string | null;
  role?: string;
  /** As stored before the fix, and indexed that way. */
  before: Direction;
  after: Direction;
}

const seeds: Record<string, Seed> = {
  // What the old route wrote: the owner's words received, the reply sent.
  owner: { category: 'agent-turn', role: 'user', before: 'inbound', after: 'outbound' },
  agent: { category: 'agent-turn', role: 'assistant', before: 'outbound', after: 'inbound' },
  // Written by the fixed route: already right.
  ownerFixed: { category: 'agent-turn', role: 'user', before: 'outbound', after: 'outbound' },
  // Nothing on the row says who spoke.
  noRole: { category: 'agent-turn', before: 'outbound', after: 'outbound' },
  // A role, but not an agent turn: an imported chat keeps what its importer said.
  imported: { category: 'ai-chat', role: 'user', before: 'inbound', after: 'inbound' },
  uncategorised: { category: null, role: 'assistant', before: 'outbound', after: 'outbound' },
};

describeWithDb(`agent-turn direction repair (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let userId: string;
  const ids: Record<string, string> = Object.fromEntries(
    Object.keys(seeds).map((key) => [key, randomUUID()]),
  );

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  async function seed(key: string): Promise<void> {
    const row = seeds[key];
    const metadata = row.role
      ? { platform: 'openclaw', role: row.role, sessionId: 's1' }
      : { platform: 'openclaw' };

    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id) VALUES ($1, 'Communication', $2)`,
      [ids[key], userId],
    );
    await q(
      `INSERT INTO ci.communications
         (id, time, user_id, communication_type, direction, thread_id, participants_metadata, content, category)
       VALUES ($1, now(), $2, 'chat', $3, 's1', $4::jsonb, $5, $6)`,
      [ids[key], userId, row.before, JSON.stringify(metadata), `seed ${key}`, row.category],
    );

    const { sql, params } = buildVectorUpsertStatement([{ text: `seed ${key}`, weight: 10 }], {
      id: randomUUID(),
      entityType: 'communication',
      entityId: ids[key],
      userId,
    });

    await q(sql, params);
  }

  async function stored(): Promise<Record<string, { direction: Direction; recordVersion: number }>> {
    const rows = await q<Array<{ id: string; direction: Direction; detail_version: number }>>(
      `SELECT c.id, c.direction, d.detail_version
         FROM ci.communications c
         JOIN ci_search.mobile_search_documents d
           ON d.entity_type = 'communication' AND d.entity_id = c.id
        WHERE c.user_id = $1`,
      [userId],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    return Object.fromEntries(
      Object.keys(seeds).map((key) => {
        const row = byId.get(ids[key]);

        return [key, { direction: row!.direction, recordVersion: Number(row!.detail_version) }];
      }),
    );
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'AgentTurnDirection');

    for (const key of Object.keys(seeds)) {
      await seed(key);
    }
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    await runner?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('indexes each seeded message with the direction it was stored with', async () => {
    const records = await q<Array<{ entity_id: string; direction: string; detail_version: number }>>(
      `SELECT entity_id, detail ->> 'direction' AS direction, detail_version
         FROM ci_search.mobile_search_documents WHERE user_id = $1`,
      [userId],
    );

    expect(
      Object.fromEntries(records.map((r) => [r.entity_id, [r.direction, Number(r.detail_version)]])),
    ).toEqual(
      Object.fromEntries(
        Object.keys(seeds).map((key) => [ids[key], [seeds[key].before, DEVICE_RECORD_VERSION]]),
      ),
    );
  });

  it('turns only agent turns round, and hands only their stale device records back to the refresh cron', async () => {
    await q(migrationUp(FLIP));
    await q(migrationUp(REFRESH));

    const after = await stored();
    const stale = (key: string) => seeds[key].before !== seeds[key].after;

    expect(after).toEqual(
      Object.fromEntries(
        Object.keys(seeds).map((key) => [
          key,
          { direction: seeds[key].after, recordVersion: stale(key) ? 0 : DEVICE_RECORD_VERSION },
        ]),
      ),
    );
  });

  it('changes nothing on a second run', async () => {
    const before = await stored();

    await q(migrationUp(FLIP));
    await q(migrationUp(REFRESH));

    expect(await stored()).toEqual(before);
  });
});
