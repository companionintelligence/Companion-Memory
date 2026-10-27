import { LoggerService } from '@ci/common/logging';
import { AccountPurgeService, buildPurgePlan, type PurgePlan } from '@ci/domains/user';
import { readFkEdges, readUserRefColumns } from '@ci/domains/user/purge/purgeCatalog';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { CONNECTION_SCOPED_TABLES } from '../dataDeletionPlan';

/**
 * What an account delete leaves behind, checked against a migrated database.
 *
 * Both account deletes (`POST /users/me/delete` and the 30-day purge) remove an
 * account's rows through the same purge, whose plan is read from the catalog:
 * the columns with a foreign key to `ci.users`, and the `user_id` /
 * `owner_user_id` columns that have none. This suite asks the question from the
 * other side. It lists every column that can name an account, by foreign key
 * (any name, any arity) or by name (uuid, uuid[] and text alike), and requires
 * each to be one the purge deletes by, one it nulls, or one written down here
 * with the reason it stays. A new column that names an account and that the
 * purge would not reach fails here, the day it is added.
 *
 * "Deletes by" means the column IS the scope of one of the plan's deletes. A
 * table the plan deletes from by another column, or through a parent, does not
 * cover its other account columns: rows of other accounts that name this one
 * there would survive.
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

/** Anything that can run parameterised SQL. */
interface SqlExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * A column name that says it holds an account: `user`, `users`, `…_user_id`,
 * `…_user_ids`, `…_by` or `is_private_to`, in a uuid, uuid[] or text column.
 * Deliberately broad: a false positive costs a line in {@link KEPT}, a miss
 * costs a deleted account's data.
 */
const ACCOUNT_COLUMN_NAME = '(^|_)users?(_ids?)?$|_by$|^is_private_to$';

/**
 * Party words, for uuid and uuid[] columns only (`owner_ref`, `grantee`,
 * `member_ids`, `account_id`, `principal_id`, `uid`, `created_for`, …): in text
 * columns they are mostly prose (an email's `subject`, a link preview's
 * `author_name`) or a provider's own account id. No uuid column in today's
 * schema matches `account`, `principal`, `uid` or `_for`, so they cost nothing
 * until a column that names an account under one of them lands.
 */
const PARTY_COLUMN_NAME =
  '^(owner|grantee|member|asker|responder|recipient|subject|actor|issuer|invitee|inviter|assignee|author|participant|viewer|reviewer|account|principal)s?(_|$)|(^|_)uid$|_for$';

/** Every column that can name an account: by foreign key to ci.users, or by name. */
const ACCOUNT_COLUMNS_SQL = `
  SELECT ns.nspname || '.' || c.relname || '.' || a.attname AS ref
    FROM pg_attribute a
    JOIN pg_class c      ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE a.attnum > 0
     AND NOT a.attisdropped
     AND ns.nspname NOT LIKE ALL (ARRAY['pg\\_%', 'information\\_schema', '\\_timescaledb%', 'timescaledb\\_%', 'pipeline\\_scratch'])
     AND (
       EXISTS (
         SELECT 1 FROM pg_constraint k
          WHERE k.contype = 'f' AND k.conrelid = c.oid
            AND k.confrelid = 'ci.users'::regclass
            AND a.attnum = ANY (k.conkey)
       )
       OR (
         a.atttypid IN ('uuid'::regtype, 'uuid[]'::regtype, 'text'::regtype, 'text[]'::regtype, 'varchar'::regtype)
         AND a.attname ~ $1
       )
       OR (a.atttypid IN ('uuid'::regtype, 'uuid[]'::regtype) AND a.attname ~ $2)
     )
   ORDER BY 1
`;

/**
 * Every application table, each with the tables it cascades from. A partition
 * is its parent's; TimescaleDB chunks live in schemas the filter drops.
 */
const TABLES_SQL = `
  SELECT ns.nspname || '.' || c.relname AS ref,
         coalesce(
           array_agg(pns.nspname || '.' || p.relname) FILTER (WHERE k.confdeltype = 'c'),
           '{}'
         ) AS cascades_from
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    LEFT JOIN pg_constraint k ON k.contype = 'f' AND k.conrelid = c.oid
    LEFT JOIN pg_class p ON p.oid = k.confrelid
    LEFT JOIN pg_namespace pns ON pns.oid = p.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND ns.nspname NOT LIKE ALL (ARRAY['pg\\_%', 'information\\_schema', '\\_timescaledb%', 'timescaledb\\_%', 'pipeline\\_scratch'])
   GROUP BY 1
   ORDER BY 1
`;

/**
 * Tables the purge deletes nothing from, by any route, each with the reason.
 *
 * The column inventory above cannot see a table with no account column and no
 * foreign key: `hbpe.summary_l1_label` was one (keyed by a summary id, with no
 * constraint), and the purge left a deleted account's labels behind until the
 * implicit edge in `purgeCatalog.ts` was added. So every table is accounted for:
 * one the plan deletes from, one that cascades from such a table, or one listed
 * here. A new table that is none of these fails here, the day it is added.
 */
const OUTSIDE_THE_PURGE: ReadonlyMap<string, string> = new Map([
  ['ci.users', "the account rows; the plan's last step deletes the account's own"],
  ['ci.account_purges', 'proof of deletion'],
  ['ci.data_deletion_audit', 'proof of deletion'],
  ['ci.ask_audit', 'removeFromAskAudit takes the account out of it'],
  ['ci.job_settings', 'appliance-wide; updated_by is nulled'],
  ['ci.outbound_settings', 'appliance-wide; updated_by is nulled'],
  ['ci.providers', 'the connector catalog'],
  ['ci.cron_runs', 'scheduler bookkeeping'],
  ['ci.job_metrics', 'queue depth samples, no ids'],
  ['ci.job_category_metrics', 'queue depth samples, no ids'],
  ['ci.retrieval_policy', 'appliance-wide ranking settings'],
  ['ci.retrieval_health_snapshots', 'appliance-wide index coverage counts'],
  ['ci.consumed_nonces', 'replay guard keys, swept on expiry (ConsumptionSweepCron)'],
  ['ci.consumption_windows', 'rate-limit windows, swept when idle (ConsumptionSweepCron)'],
  ['ci.geocode_cache', 'appliance-wide geocoding cache keyed by query, shared by every account'],
  ['ci_search.index_skips', 'entity ids the indexer skipped; no account column, no foreign key'],
  ['hbpe.kind_l0_map', 'static classification table'],
  ['public.schema_migrations', 'migration bookkeeping'],
  ['public.spatial_ref_sys', 'PostGIS reference data'],
]);

/**
 * Columns that name an account and stay after its delete, each with the reason.
 * An entry here is a claim about the purge's behaviour or about what the column
 * holds; it needs the same scrutiny as the code.
 */
const KEPT: ReadonlyMap<string, string> = new Map([
  // Taken out by `removeFromAskAudit`, which the purge runs before its plan
  // (AccountPurgeService.integration.spec pins it): the other party's record.
  ['ci.ask_audit.asker_user_id', 'removeFromAskAudit'],
  ['ci.ask_audit.responder_user_id', 'removeFromAskAudit'],
  // The record that a deletion happened: a pseudonymous id and counts.
  ['ci.data_deletion_audit.subject_user_id', 'proof of deletion'],
  ['ci.data_deletion_audit.requested_by_user_id', 'proof of deletion'],
  ['ci.account_purges.user_id', 'proof of deletion'],
  // Names that match and hold no account. The rows are their owner's, deleted
  // with that owner by its own column.
  ['ci.api_keys.managed_by', 'the installed app that manages the key'],
  ['ci.entity_type_proposals.detected_by', 'the detector that proposed it'],
  ['ci.graph_enrichment_proposals.detected_by', 'the detector that proposed it'],
  ['ci.merge_candidates.detected_by', 'the detector that proposed it'],
  ['ci.events.created_by', "free text from the event's source (an organiser, a system), not an account id"],
  ['ci.ask_grants.grantee_peer_link_id', 'a peer link, not a local account'],
  ['ci.events.participant_entity_ids', 'entity ids'],
  ['ci.summaries.participants', 'entity ids'],
  ['ci.identifier_claims.subject_id', 'the entity or object an identifier names'],
  ['ci.object_identifiers.subject_id', 'the entity or object an identifier names'],
]);

/** The column refs the plan deletes by and nulls. */
function coverage(plan: PurgePlan): { deletedBy: Set<string>; nulled: Set<string> } {
  const deletedBy = new Set<string>();
  const nulled = new Set<string>();

  for (const step of plan.steps) {
    const table = `${step.target.schema}.${step.target.table}`;

    if (step.kind === 'delete' && step.scope.kind === 'owned') {
      deletedBy.add(`${table}.${step.scope.column}`);
    } else if (step.kind === 'null' && step.scope.kind === 'owned') {
      nulled.add(`${table}.${step.column}`);
    }
  }

  return { deletedBy, nulled };
}

async function planFor(executor: SqlExecutor): Promise<PurgePlan> {
  const usersTable = { schema: 'ci', table: 'users' };
  const [userColumns, edges] = await Promise.all([
    readUserRefColumns(executor, usersTable),
    readFkEdges(executor),
  ]);

  return buildPurgePlan({ userColumns, edges, usersTable });
}

/** Every account column the purge would leave naming a deleted account. */
async function uncoveredAccountColumns(executor: SqlExecutor): Promise<{ all: string[]; left: string[] }> {
  const rows = (await executor.query(ACCOUNT_COLUMNS_SQL, [
    ACCOUNT_COLUMN_NAME,
    PARTY_COLUMN_NAME,
  ])) as Array<{ ref: string }>;
  const { deletedBy, nulled } = coverage(await planFor(executor));
  const all = rows.map((row) => row.ref);

  return {
    all,
    left: all.filter((ref) => !deletedBy.has(ref) && !nulled.has(ref) && !KEPT.has(ref)),
  };
}

describeWithDatabase(`account deletion coverage, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'dataDeletionPlan.integration.spec' });
    await scratch.assertOwn();
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('every connection-scoped table the disconnect names exists', async () => {
    const columns = await scratch.dataSource.query<Array<{ ref: string }>>(
      `SELECT table_schema || '.' || table_name || '.' || column_name AS ref FROM information_schema.columns`,
    );
    const known = new Set(columns.map((c) => c.ref));
    const missing = CONNECTION_SCOPED_TABLES.map(
      (t) => `${t.schema}.${t.table}.${t.connectionColumn}`,
    ).filter((ref) => !known.has(ref));

    expect(missing).toEqual([]);
  });

  it('checks the plan the purge itself runs', async () => {
    const service = new AccountPurgeService(scratch.dataSource, new LoggerService());

    expect(await service.describePlan()).toEqual(await planFor(scratch.dataSource));
  });

  it('leaves no column naming the account behind: each is deleted by, nulled, or kept for a stated reason', async () => {
    const { all, left } = await uncoveredAccountColumns(scratch.dataSource);

    // The inventory is not empty by accident: today's schema has well over a
    // hundred such columns, the ones the purge's own discovery reads among them.
    expect(all.length).toBeGreaterThan(100);
    expect(all).toEqual(expect.arrayContaining(['ci.notes.user_id', 'ci.entities.owner_user_id']));
    expect(left).toEqual([]);
  });

  it('every entry kept on purpose still exists, so a stale one cannot hide a new column', async () => {
    const { all } = await uncoveredAccountColumns(scratch.dataSource);

    expect([...KEPT.keys()].filter((ref) => !all.includes(ref))).toEqual([]);
  });

  it('accounts for every table: purged, cascading from a purged one, or listed with a reason', async () => {
    const plan = await planFor(scratch.dataSource);
    const tables =
      await scratch.dataSource.query<Array<{ ref: string; cascades_from: string[] }>>(TABLES_SQL);
    const purged = new Set(plan.purgedTables);
    const reached = (table: { ref: string; cascades_from: string[] }) =>
      purged.has(table.ref) || table.cascades_from.some((parent) => purged.has(parent));

    expect(tables.length).toBeGreaterThan(100);
    expect(tables.filter((table) => !reached(table) && !OUTSIDE_THE_PURGE.has(table.ref))).toEqual([]);
    // And no stale entry: a table listed here that the purge now reaches, or that is gone.
    expect(
      [...OUTSIDE_THE_PURGE.keys()].filter(
        (ref) => !tables.some((table) => table.ref === ref && !reached(table)),
      ),
    ).toEqual([]);
  });

  it('reaches hbpe.summary_l1_label, which has no account column and no foreign key', async () => {
    // Pinned on its own, because dropping the implicit edge in purgeCatalog.ts
    // would otherwise only move the table into the list above.
    expect((await planFor(scratch.dataSource)).purgedTables).toContain('hbpe.summary_l1_label');
  });

  it('nulls every account pointer into the purged entities, not just its own', async () => {
    // ci.users.entity_id of another account naming one of the purged entities.
    // Deleting through it removed that account; scoping it to `id = $1` left
    // the purge failing on the foreign key for good.
    const detach = (await planFor(scratch.dataSource)).steps.filter(
      (step) => step.kind === 'null' && step.target.table === 'users' && step.column === 'entity_id',
    );

    expect(detach).toEqual([
      expect.objectContaining({
        scope: expect.objectContaining({
          kind: 'referencesPurged',
          parent: { schema: 'ci', table: 'entities', column: 'entity_id' },
        }),
      }),
    ]);
  });

  it('fails for a new account column the purge would not reach, whatever its shape', async () => {
    const runner = scratch.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      // A second account column on a table the plan already deletes from, an
      // array of accounts, a name outside the `user_id` convention, and a new
      // table with both. Plus one with a foreign key under an unusual name,
      // which the purge does reach.
      await runner.query(`
        ALTER TABLE ci.notes
          ADD COLUMN reviewer_user_id uuid,
          ADD COLUMN member_ids uuid[],
          ADD COLUMN grantee uuid REFERENCES ci.users (id)`);
      await runner.query(
        `CREATE TABLE ci.zz_guard_probe (
           id uuid PRIMARY KEY, owner_ref uuid, user_ids text[],
           account_id uuid, principal_id uuid, uid uuid, created_for uuid)`,
      );

      const { left } = await uncoveredAccountColumns(runner);

      expect(left).toEqual([
        'ci.notes.member_ids',
        'ci.notes.reviewer_user_id',
        'ci.zz_guard_probe.account_id',
        'ci.zz_guard_probe.created_for',
        'ci.zz_guard_probe.owner_ref',
        'ci.zz_guard_probe.principal_id',
        'ci.zz_guard_probe.uid',
        'ci.zz_guard_probe.user_ids',
      ]);
      expect(coverage(await planFor(runner)).deletedBy).toContain('ci.notes.grantee');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
