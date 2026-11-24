import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';

/**
 * 20261027041509: ONBOARDING'S PARENT AND CHILD LINKS, TURNED THE RIGHT WAY ROUND.
 *
 * Onboarding wrote "Morgan, Parent" as `me PARENT_OF Morgan` and "Riley, Child"
 * as `me CHILD_OF Riley` (stored swapped, as `Riley PARENT_OF me`). PARENT_OF
 * points from parent to child, so both said the opposite. The migration swaps
 * the endpoints of exactly those rows, on rows Postgres holds, in one
 * transaction that is rolled back.
 *
 * Opt-in like the sibling integration specs: set ONBOARDING_TEST_DATABASE_URL
 * to a migrated database of your own, or run `make test-db`.
 */

const DATABASE_ENV = { urlEnvVar: 'ONBOARDING_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[onboarding/repairOnboardingParentChild.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

function migrationUp(): string {
  const file = path.resolve(
    __dirname,
    '../../../../db/postgres/migrations/20261027041509_repair_onboarding_parent_child_direction.sql',
  );
  const sql = readFileSync(file, 'utf8');
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');

  if (start < 0 || end < 0) {
    throw new Error(`${file} has no migrate:up / migrate:down markers.`);
  }

  return sql.slice(start + '-- migrate:up'.length, end);
}

interface Edge {
  from: string;
  to: string;
  type: string;
  active: boolean;
}

describeWithDb(`onboarding parent and child repair (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let userId: string;
  const me = randomUUID();
  const morgan = randomUUID();
  const riley = randomUUID();
  const sam = randomUUID();
  const jordan = randomUUID();
  const mom = randomUUID();
  const ids: Record<string, string> = {};

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  async function edge(
    key: string,
    from: string,
    to: string,
    type: string,
    source: string | null,
  ): Promise<void> {
    const [row] = await q<Array<{ relationship_id: string }>>(
      `INSERT INTO ci.relationships
         (from_entity_id, to_entity_id, relationship_type, owner_user_id, properties, from_entity_type, to_entity_type)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'person', 'person')
       RETURNING relationship_id`,
      [from, to, type, userId, JSON.stringify(source ? { source } : {})],
    );

    ids[key] = row.relationship_id;
  }

  async function stored(key: string): Promise<Edge> {
    const [row] = await q<
      Array<{ from_entity_id: string; to_entity_id: string; relationship_type: string; is_active: boolean }>
    >(
      'SELECT from_entity_id, to_entity_id, relationship_type, is_active FROM ci.relationships WHERE relationship_id = $1',
      [ids[key]],
    );

    return {
      from: row.from_entity_id,
      to: row.to_entity_id,
      type: row.relationship_type,
      active: row.is_active,
    };
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

    userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'OnboardingParentChild');

    // What the old onboarding wrote for "Morgan, Parent" and "Riley, Child".
    await edge('parent', me, morgan, 'PARENT_OF', 'onboarding');
    await edge('child', riley, me, 'PARENT_OF', 'onboarding');
    // A CHILD_OF stored as written, before the alias was swapped at write time.
    await edge('legacyChild', me, sam, 'CHILD_OF', 'onboarding');
    // Not onboarding's: an import's parent link stays as it is.
    await edge('imported', jordan, me, 'PARENT_OF', null);
    // Onboarding's, but not a parent or child.
    await edge('friend', me, jordan, 'FRIENDS_WITH', 'onboarding');
    // The same tie twice: onboarding's backwards row and an import's right one.
    await edge('backwards', me, mom, 'PARENT_OF', 'onboarding');
    await edge('right', mom, me, 'PARENT_OF', null);

    // Once, as dbmate runs it.
    await q(migrationUp());
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

  it('turns round only onboarding parent and child links', async () => {
    expect(await stored('parent')).toEqual({ from: morgan, to: me, type: 'PARENT_OF', active: true });
    expect(await stored('child')).toEqual({ from: me, to: riley, type: 'PARENT_OF', active: true });
    expect(await stored('legacyChild')).toEqual({ from: sam, to: me, type: 'CHILD_OF', active: true });
    expect(await stored('imported')).toEqual({ from: jordan, to: me, type: 'PARENT_OF', active: true });
    expect(await stored('friend')).toEqual({ from: me, to: jordan, type: 'FRIENDS_WITH', active: true });
  });

  it('retires a backwards row whose corrected edge already exists, instead of colliding with it', async () => {
    expect(await stored('backwards')).toEqual({ from: me, to: mom, type: 'PARENT_OF', active: false });
    expect(await stored('right')).toEqual({ from: mom, to: me, type: 'PARENT_OF', active: true });
  });
});
