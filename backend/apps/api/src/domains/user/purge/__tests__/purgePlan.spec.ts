import { buildPurgePlan } from '../purgePlan';
import type { FkEdge, PurgePlan, UserRefColumn } from '../types';

/**
 * The purge plan decides what an irreversible job deletes. It is a pure function
 * precisely so that decision can be asserted here rather than discovered on an
 * appliance, and every case below is a shape that exists in the real schema.
 */

const USERS = { schema: 'ci', table: 'users' };

function fk(
  child: string,
  childColumn: string,
  parent: string,
  deleteAction: FkEdge['deleteAction'],
  parentColumn = 'id',
): FkEdge {
  const [childSchema, childTable] = child.split('.');
  const [parentSchema, parentTable] = parent.split('.');

  return {
    constraintName: `${childTable}_${childColumn}_fkey`,
    childSchema,
    childTable,
    childColumn,
    parentSchema,
    parentTable,
    parentColumn,
    deleteAction,
  };
}

function userColumn(
  table: string,
  column: string,
  deleteAction: UserRefColumn['deleteAction'],
): UserRefColumn {
  const [schema, name] = table.split('.');

  return {
    schema,
    table: name,
    column,
    deleteAction,
    constraintName: deleteAction === null ? null : `${name}_${column}_fkey`,
  };
}

function stepIds(plan: PurgePlan): string[] {
  return plan.steps.map((step) => step.id);
}

function indexOf(plan: PurgePlan, id: string): number {
  const index = stepIds(plan).indexOf(id);

  expect(stepIds(plan)).toContain(id);

  return index;
}

describe('buildPurgePlan', () => {
  describe('what counts as the account’s data', () => {
    it('deletes rows scoped by NO ACTION, CASCADE and convention alike', () => {
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [
          userColumn('ci.notes', 'user_id', 'a'),
          userColumn('ci.events', 'user_id', 'c'),
          // No foreign key at all — ci_search.embeddings is exactly this, and it
          // holds the vector form of the user's memories.
          userColumn('ci_search.embeddings', 'user_id', null),
        ],
        edges: [fk('ci.notes', 'user_id', 'ci.users', 'a'), fk('ci.events', 'user_id', 'ci.users', 'c')],
      });

      expect(plan.purgedTables).toEqual(['ci.events', 'ci.notes', 'ci_search.embeddings']);
      expect(plan.warnings).toEqual([]);
    });

    it('deletes a SET NULL column when it is the only user reference on the table', () => {
      // ci.entities and ci.relationships: owned solely through owner_user_id, so
      // honouring SET NULL would keep the user's memories and graph edges with
      // the owner blanked out — anonymised, not deleted.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.entities', 'owner_user_id', 'n')],
        edges: [fk('ci.entities', 'owner_user_id', 'ci.users', 'n')],
      });

      expect(plan.purgedTables).toEqual(['ci.entities']);
      expect(plan.detachedColumns).toEqual([]);
    });

    it('only nulls a SET NULL column when another column already owns the row', () => {
      // ci.receipts.owner_user_id attributes a receipt that ci.receipts.user_id
      // owns. The row dies via user_id; the attribution on somebody else's row
      // must not take their row with it.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [
          userColumn('ci.receipts', 'user_id', 'c'),
          userColumn('ci.receipts', 'owner_user_id', 'n'),
        ],
        edges: [
          fk('ci.receipts', 'user_id', 'ci.users', 'c'),
          fk('ci.receipts', 'owner_user_id', 'ci.users', 'n'),
        ],
      });

      expect(plan.purgedTables).toEqual(['ci.receipts']);
      expect(plan.detachedColumns).toEqual(['ci.receipts.owner_user_id']);
    });
  });

  describe('who changed a row is not whose it is', () => {
    it('nulls updated_by on an appliance-wide row instead of deleting the row', () => {
      // ci.outbound_settings: one row per outbound switch for the whole appliance,
      // and updated_by is its only reference to ci.users. Deleting the row puts
      // the switch back to its default (on) for everyone else.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [
          userColumn('ci.outbound_settings', 'updated_by', 'n'),
          userColumn('ci.job_settings', 'updated_by', 'n'),
        ],
        edges: [
          fk('ci.outbound_settings', 'updated_by', 'ci.users', 'n'),
          fk('ci.job_settings', 'updated_by', 'ci.users', 'n'),
        ],
      });

      expect(plan.purgedTables).toEqual([]);
      expect(plan.detachedColumns).toEqual(['ci.job_settings.updated_by', 'ci.outbound_settings.updated_by']);
      expect(stepIds(plan)).toEqual([
        'detach:ci.job_settings:updated_by',
        'detach:ci.outbound_settings:updated_by',
        'delete:ci.users',
      ]);
    });

    it('still deletes a row a provenance-named column owns by cascade', () => {
      // ci.signup_code.issued_by is ON DELETE CASCADE: the invitations the
      // account issued go with it, as they always did.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.signup_code', 'issued_by', 'c')],
        edges: [fk('ci.signup_code', 'issued_by', 'ci.users', 'c')],
      });

      expect(plan.purgedTables).toEqual(['ci.signup_code']);
      expect(plan.detachedColumns).toEqual([]);
    });
  });

  describe('the account row itself', () => {
    it('never treats a reference on ci.users as something to delete through', () => {
      // ci.users.created_by points at the account that provisioned another
      // account. Following it would delete live users.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.users', 'created_by', 'a')],
        edges: [fk('ci.users', 'created_by', 'ci.users', 'a')],
      });

      expect(plan.purgedTables).toEqual([]);
      expect(plan.detachedColumns).toEqual(['ci.users.created_by']);
      expect(stepIds(plan)).toEqual(['detach:ci.users:created_by', 'delete:ci.users']);
    });

    it('deletes the account row last', () => {
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.notes', 'user_id', 'a')],
        edges: [fk('ci.notes', 'user_id', 'ci.users', 'a')],
      });

      expect(plan.steps.at(-1)).toMatchObject({ kind: 'deleteUser', target: USERS });
    });

    it('breaks a reference pointing out of ci.users into rows being deleted', () => {
      // ci.users.entity_id -> ci.entities is NO ACTION while
      // ci.entities.owner_user_id -> ci.users is SET NULL: a genuine cycle that
      // only nulling the users-side column can break.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.entities', 'owner_user_id', 'n')],
        edges: [
          fk('ci.entities', 'owner_user_id', 'ci.users', 'n'),
          fk('ci.users', 'entity_id', 'ci.entities', 'a'),
        ],
      });

      expect(indexOf(plan, 'detach:ci.users:entity_id')).toBeLessThan(
        indexOf(plan, 'delete:ci.entities:owner_user_id'),
      );
    });

    it('never deletes another account row through such a reference', () => {
      // The blocking walk used to follow ci.users.entity_id like any blocking
      // child, adding a step that deleted every account whose `entity_id` named
      // one of this account's entities.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.entities', 'owner_user_id', 'n')],
        edges: [
          fk('ci.entities', 'owner_user_id', 'ci.users', 'n'),
          fk('ci.users', 'entity_id', 'ci.entities', 'a'),
        ],
      });

      expect(stepIds(plan).filter((id) => id.startsWith('delete:ci.users'))).toEqual(['delete:ci.users']);
    });

    it('deletes a SET NULL child before its parent, so its rows are not rewritten first', () => {
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [
          userColumn('ci.entities', 'owner_user_id', 'n'),
          userColumn('ci.position', 'user_id', 'c'),
        ],
        edges: [
          fk('ci.entities', 'owner_user_id', 'ci.users', 'n'),
          fk('ci.position', 'user_id', 'ci.users', 'c'),
          fk('ci.position', 'location_entity_id', 'ci.entities', 'n'),
        ],
      });

      expect(indexOf(plan, 'delete:ci.position:user_id')).toBeLessThan(
        indexOf(plan, 'delete:ci.entities:owner_user_id'),
      );
      expect(plan.warnings).toEqual([]);
    });

    it('drops a SET NULL ordering hint silently when it closes a cycle', () => {
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.a', 'user_id', 'a'), userColumn('ci.b', 'user_id', 'a')],
        edges: [
          fk('ci.a', 'user_id', 'ci.users', 'a'),
          fk('ci.b', 'user_id', 'ci.users', 'a'),
          fk('ci.a', 'b_id', 'ci.b', 'a'),
          fk('ci.b', 'a_id', 'ci.a', 'n'),
        ],
      });

      expect(indexOf(plan, 'delete:ci.a:user_id')).toBeLessThan(indexOf(plan, 'delete:ci.b:user_id'));
      expect(plan.warnings).toEqual([]);
    });
  });

  describe('tables that block the delete without being the account’s', () => {
    it('deletes them, scoped through the parent they block', () => {
      // hbpe.l2_content_cluster has no user column but references ci.content
      // with NO ACTION. Without this step the purge fails part-way through.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.content', 'user_id', 'a')],
        edges: [
          fk('ci.content', 'user_id', 'ci.users', 'a'),
          fk('hbpe.l2_content_cluster', 'content_id', 'ci.content', 'a'),
        ],
      });

      const dependent = plan.steps.find((step) => step.id.startsWith('delete:hbpe.l2_content_cluster'));

      expect(dependent).toMatchObject({
        kind: 'delete',
        target: { schema: 'hbpe', table: 'l2_content_cluster' },
        scope: {
          kind: 'referencesPurged',
          column: 'content_id',
          parent: { schema: 'ci', table: 'content', column: 'id' },
          parentScope: { kind: 'owned', column: 'user_id' },
        },
      });

      expect(indexOf(plan, dependent!.id)).toBeLessThan(indexOf(plan, 'delete:ci.content:user_id'));
    });

    it('follows the chain further than one hop', () => {
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci_search.tags', 'user_id', null)],
        edges: [
          fk('ci_search.entity_tag', 'tag_id', 'ci_search.tags', 'a'),
          fk('ci_search.entity_tag_note', 'entity_tag_id', 'ci_search.entity_tag', 'a'),
        ],
      });

      expect(plan.purgedTables).toEqual([
        'ci_search.entity_tag',
        'ci_search.entity_tag_note',
        'ci_search.tags',
      ]);

      // Grandchild before child before parent.
      const grandchild = indexOf(
        plan,
        'delete:ci_search.entity_tag_note:entity_tag_id->ci_search.entity_tag.id',
      );
      const child = indexOf(plan, 'delete:ci_search.entity_tag:tag_id->ci_search.tags.id');

      expect(grandchild).toBeLessThan(child);
      expect(child).toBeLessThan(indexOf(plan, 'delete:ci_search.tags:user_id'));
    });

    it('leaves a user-scoped child to its own scope rather than deleting through the parent', () => {
      // ci.actions references ci.threads with NO ACTION and is user-scoped in
      // its own right. Scoping it through threads instead would delete another
      // account's action that happened to reference this account's thread.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.actions', 'user_id', 'a'), userColumn('ci.threads', 'user_id', 'c')],
        edges: [
          fk('ci.actions', 'user_id', 'ci.users', 'a'),
          fk('ci.threads', 'user_id', 'ci.users', 'c'),
          fk('ci.actions', 'thread_id', 'ci.threads', 'a'),
        ],
      });

      expect(stepIds(plan)).not.toContain('delete:ci.actions:thread_id->ci.threads.id');
      expect(indexOf(plan, 'delete:ci.actions:user_id')).toBeLessThan(
        indexOf(plan, 'delete:ci.threads:user_id'),
      );
    });
  });

  describe('ordering', () => {
    it('empties a child table before its parent', () => {
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.messages', 'user_id', 'c'), userColumn('ci.threads', 'user_id', 'c')],
        edges: [
          fk('ci.messages', 'user_id', 'ci.users', 'c'),
          fk('ci.threads', 'user_id', 'ci.users', 'c'),
          fk('ci.messages', 'thread_id', 'ci.threads', 'c'),
        ],
      });

      expect(indexOf(plan, 'delete:ci.messages:user_id')).toBeLessThan(
        indexOf(plan, 'delete:ci.threads:user_id'),
      );
    });

    it('flattens a self-referencing hierarchy before deleting it', () => {
      // A batch has no idea which rows are parents. ci.messages,
      // ci.threads and ci.objects all carry a NO ACTION self reference.
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.messages', 'user_id', 'c')],
        edges: [
          fk('ci.messages', 'user_id', 'ci.users', 'c'),
          fk('ci.messages', 'parent_message_id', 'ci.messages', 'a'),
        ],
      });

      expect(plan.steps[0]).toMatchObject({
        kind: 'null',
        column: 'parent_message_id',
        target: { schema: 'ci', table: 'messages' },
      });

      expect(indexOf(plan, 'flatten:ci.messages:parent_message_id')).toBeLessThan(
        indexOf(plan, 'delete:ci.messages:user_id'),
      );
    });

    it('is stable across catalog orderings', () => {
      const userColumns = [
        userColumn('ci.messages', 'user_id', 'c'),
        userColumn('ci.threads', 'user_id', 'c'),
        userColumn('ci.notes', 'user_id', 'a'),
      ];

      const edges = [
        fk('ci.messages', 'user_id', 'ci.users', 'c'),
        fk('ci.threads', 'user_id', 'ci.users', 'c'),
        fk('ci.notes', 'user_id', 'ci.users', 'a'),
        fk('ci.messages', 'thread_id', 'ci.threads', 'c'),
      ];

      const forwards = buildPurgePlan({ usersTable: USERS, userColumns, edges });
      const backwards = buildPurgePlan({
        usersTable: USERS,
        userColumns: [...userColumns].reverse(),
        edges: [...edges].reverse(),
      });

      expect(stepIds(forwards)).toEqual(stepIds(backwards));
    });
  });

  describe('refusing to run', () => {
    it('warns rather than guessing when two tables block each other', () => {
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.a', 'user_id', 'a'), userColumn('ci.b', 'user_id', 'a')],
        edges: [
          fk('ci.a', 'user_id', 'ci.users', 'a'),
          fk('ci.b', 'user_id', 'ci.users', 'a'),
          fk('ci.a', 'b_id', 'ci.b', 'a'),
          fk('ci.b', 'a_id', 'ci.a', 'a'),
        ],
      });

      expect(plan.warnings).toHaveLength(1);
      expect(plan.warnings[0]).toMatch(/cycle/i);
    });

    it('drops a cascade ordering hint rather than failing on the cycle it created', () => {
      const plan = buildPurgePlan({
        usersTable: USERS,
        userColumns: [userColumn('ci.a', 'user_id', 'a'), userColumn('ci.b', 'user_id', 'a')],
        edges: [
          fk('ci.a', 'user_id', 'ci.users', 'a'),
          fk('ci.b', 'user_id', 'ci.users', 'a'),
          fk('ci.a', 'b_id', 'ci.b', 'c'),
          fk('ci.b', 'a_id', 'ci.a', 'c'),
        ],
      });

      expect(plan.warnings).toHaveLength(1);
      expect(plan.warnings[0]).toMatch(/Cascade ordering hints dropped/);
      expect(plan.purgedTables).toEqual(['ci.a', 'ci.b']);
    });
  });
});
