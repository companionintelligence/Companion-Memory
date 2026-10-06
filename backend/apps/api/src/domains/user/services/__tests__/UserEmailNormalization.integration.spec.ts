import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isUniqueViolation } from '@ci/common/constants';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Lower-casing every address must not fail an upgrade that finds case twins.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * {@link MIGRATION} stores addresses lower-cased and adds a unique index on `lower(email)`. A box
 * that already holds `Owner@example.com` and `owner@example.com` cannot satisfy that index, and a
 * migration that died on it would stop `migrate` on that box for good. So the migration flags such
 * rows, leaves them exactly as they are (each still signs in with its exact address), normalizes
 * everything else and builds the index over the rest.
 *
 * This rolls the scratch database's copy of the migration back, seeds the rows an old appliance
 * can hold, and applies the up half verbatim the way dbmate does.
 *
 * Skips (loudly) without an administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const MIGRATION = '20261006065832_users_email_lowercase_and_proven.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

function migrationHalf(half: 'up' | 'down'): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return half === 'up' ? sql.slice(0, down) : sql.slice(down);
}

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[UserEmailNormalization.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

type Row = { email: string; email_case_conflict: boolean; email_proven_at: Date | null; created_at: Date };

describeWithDatabase(`ci.users email normalization migration (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let rows: Map<string, Row>;

  async function insert(label: string, email: string): Promise<void> {
    await scratch.dataSource.query(
      `INSERT INTO ci.users (id, name, email, created_at) VALUES (ci.gen_uuid_v7(), $1, $2, now() - interval '30 days')`,
      [label, email],
    );
  }

  async function run(sql: string): Promise<void> {
    await scratch.assertOwn();

    const runner = scratch.dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.query(sql);
      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();

      throw err;
    } finally {
      await runner.release();
    }
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'users email normalization migration' });
    await scratch.assertOwn();

    // Back to the schema an appliance has before this release.
    await run(migrationHalf('down'));

    await insert('twin-a', 'Owner@Example.com');
    await insert('twin-b', 'owner@example.com');
    await insert('twin-c', ' OWNER@example.com');
    await insert('mixed', 'Mixed.Case@Example.COM');
    await insert('padded', '  padded@example.com ');
    await insert('plain', 'plain@example.com');

    await run(migrationHalf('up'));

    const result = (await scratch.dataSource.query(
      `SELECT name, email, email_case_conflict, email_proven_at, created_at FROM ci.users`,
    )) as Array<Row & { name: string }>;

    rows = new Map(result.map(({ name, ...row }) => [name, row]));
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('leaves rows that collide by case exactly as they were, and flags them', () => {
    expect(rows.get('twin-a')).toMatchObject({ email: 'Owner@Example.com', email_case_conflict: true });
    expect(rows.get('twin-b')).toMatchObject({ email: 'owner@example.com', email_case_conflict: true });
    expect(rows.get('twin-c')).toMatchObject({ email: ' OWNER@example.com', email_case_conflict: true });
  });

  it('lower-cases and trims every other address', () => {
    expect(rows.get('mixed')).toMatchObject({ email: 'mixed.case@example.com', email_case_conflict: false });
    expect(rows.get('padded')).toMatchObject({ email: 'padded@example.com', email_case_conflict: false });
    expect(rows.get('plain')).toMatchObject({ email: 'plain@example.com', email_case_conflict: false });
  });

  it('counts every account that existed as proven, so nobody loses a Portal or Hub link on upgrade', () => {
    for (const row of rows.values()) {
      expect(row.email_proven_at).toEqual(row.created_at);
    }
  });

  it('refuses a new account whose address matches a normalized one in another case', async () => {
    let error: unknown;

    try {
      await scratch.dataSource.query(
        `INSERT INTO ci.users (id, name, email) VALUES (ci.gen_uuid_v7(), 'variant', 'MIXED.case@example.com')`,
      );
    } catch (caught) {
      error = caught;
    }

    expect(isUniqueViolation(error)).toBe(true);
  });

  it('defaults a new account to no flag and no proof', async () => {
    const [created] = (await scratch.dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES (ci.gen_uuid_v7(), 'fresh', 'fresh@example.com')
       RETURNING email_case_conflict, email_proven_at`,
    )) as Array<{ email_case_conflict: boolean; email_proven_at: Date | null }>;

    expect(created).toEqual({ email_case_conflict: false, email_proven_at: null });
  });
});
