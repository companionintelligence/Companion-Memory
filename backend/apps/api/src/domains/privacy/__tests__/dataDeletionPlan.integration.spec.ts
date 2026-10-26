import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { CONNECTION_SCOPED_TABLES, USER_OWNED_TABLES } from '../dataDeletionPlan';

/**
 * The disconnect and account-deletion plans name tables and columns as
 * strings; a typo there is a delete that silently matches nothing, and a
 * column that does not exist fails the whole account deletion with a 500.
 * Checked against a migrated database, for what the migrations create
 * (including the hbpe schema).
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[dataDeletionPlan.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

describeWithDatabase(`data-deletion plans, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'dataDeletionPlan.integration.spec' });
    await scratch.assertOwn();
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('every connection-scoped and ci_etl table the plans name exists', async () => {
    const columns = await scratch.dataSource.query<Array<{ ref: string }>>(
      `SELECT table_schema || '.' || table_name || '.' || column_name AS ref FROM information_schema.columns`,
    );
    const known = new Set(columns.map((c) => c.ref));
    const missing = [
      ...CONNECTION_SCOPED_TABLES.map((t) => `${t.schema}.${t.table}.${t.connectionColumn}`),
      ...USER_OWNED_TABLES.filter((t) => t.schema === 'ci_etl').map(
        (t) => `${t.schema}.${t.table}.${t.userColumn}`,
      ),
    ].filter((ref) => !known.has(ref));

    expect(missing).toEqual([]);
  });

  it('every user-owned table the plan names, where it exists, has the columns its delete uses', async () => {
    const columns = await scratch.dataSource.query<Array<{ ref: string; tbl: string }>>(
      `SELECT table_schema || '.' || table_name || '.' || column_name AS ref,
              table_schema || '.' || table_name AS tbl
         FROM information_schema.columns`,
    );
    const known = new Set(columns.map((c) => c.ref));
    const tables = new Set(columns.map((c) => c.tbl));

    // A table the plan names that this schema lacks is skipped at run time
    // (`deleteUserOwned` treats a missing relation as nothing to delete), but a
    // missing COLUMN on a table that is there is a failed deletion.
    const missing = USER_OWNED_TABLES.filter((t) => tables.has(`${t.schema}.${t.table}`)).flatMap((t) =>
      t.through
        ? [
            `${t.schema}.${t.table}.${t.through.column}`,
            `${t.through.parentSchema}.${t.through.parentTable}.${t.through.parentKey}`,
            `${t.through.parentSchema}.${t.through.parentTable}.${t.userColumn}`,
          ]
        : [`${t.schema}.${t.table}.${t.userColumn}`],
    );

    expect(missing.filter((ref) => !known.has(ref))).toEqual([]);
  });

  it('nothing outside the plan, and nothing later in it, holds a blocking reference into a table it purges', async () => {
    // NO ACTION / RESTRICT references (deferred ones are checked at commit, after
    // the whole plan has run). The user row is deleted after every planned table.
    const references = await scratch.dataSource.query<Array<{ child: string; parent: string; name: string }>>(
      `SELECT cn.nspname || '.' || c.relname AS child, pn.nspname || '.' || p.relname AS parent, k.conname AS name
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace cn ON cn.oid = c.relnamespace
         JOIN pg_class p ON p.oid = k.confrelid
         JOIN pg_namespace pn ON pn.oid = p.relnamespace
        WHERE k.contype = 'f'
          AND k.confdeltype IN ('a', 'r')
          AND NOT k.condeferrable
          AND k.conrelid <> k.confrelid`,
    );
    const order = USER_OWNED_TABLES.map((t) => `${t.schema}.${t.table}`);
    const position = (table: string) => (table === 'ci.users' ? order.length : order.indexOf(table));

    // Handled by the service before the plan runs: it clears ci.users.entity_id
    // and deletes ci_search.entity_tag through the user's tags.
    const handled = new Set(['users_entity_id_fkey', 'entity_tag_tag_id_fkey']);

    const blocking = references
      .filter((r) => position(r.parent) >= 0 && !handled.has(r.name))
      .filter((r) => position(r.child) < 0 || position(r.child) > position(r.parent))
      .map((r) => `${r.name}: ${r.child} -> ${r.parent}`);

    expect(blocking).toEqual([]);
  });
});
