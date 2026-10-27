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
 * `member_ids`, …): in text columns they are mostly prose (an email's
 * `subject`, a link preview's `author_name`).
 */
const PARTY_COLUMN_NAME =
  '^(owner|grantee|member|asker|responder|recipient|subject|actor|issuer|invitee|inviter|assignee|author|participant|viewer|reviewer)s?(_|$)';

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
        `CREATE TABLE ci.zz_guard_probe (id uuid PRIMARY KEY, owner_ref uuid, user_ids text[])`,
      );

      const { left } = await uncoveredAccountColumns(runner);

      expect(left).toEqual([
        'ci.notes.member_ids',
        'ci.notes.reviewer_user_id',
        'ci.zz_guard_probe.owner_ref',
        'ci.zz_guard_probe.user_ids',
      ]);
      expect(coverage(await planFor(runner)).deletedBy).toContain('ci.notes.grantee');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
