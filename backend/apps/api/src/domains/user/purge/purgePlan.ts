import type { FkEdge, PurgePlan, PurgeScope, PurgeStep, TableRef, UserRefColumn } from './types';

/**
 * A column that records who made or changed a row: `updated_by`,
 * `changed_by_user_id` and the like. Under `SET NULL` it is attribution, never
 * ownership (see the rules on {@link buildPurgePlan}). The verbs are spelled out
 * so a column such as `owned_by` is not caught by accident and its rows left
 * behind.
 */
const PROVENANCE_COLUMN = /^(created|updated|changed|modified|issued)_by(_user_id)?$/;

/**
 * Build the ordered list of statements that removes one account's data.
 *
 * ## Why this exists rather than `ON DELETE CASCADE`
 *
 * The obvious alternative is a migration that rewrites every foreign key into
 * `ON DELETE CASCADE` and lets `DELETE FROM ci.users` do the work. It was
 * rejected for four reasons, in descending order of importance:
 *
 *  1. **A cascade cannot be batched.** It is one statement in one transaction.
 *     On an appliance holding a million-plus rows that means a long lock and a
 *     plausible `statement_timeout`, and a timeout rolls the whole thing back —
 *     so the largest accounts, the ones that most need purging, would make *zero*
 *     forward progress no matter how often the job ran. Batched deletes commit as
 *     they go, which is what makes the job resumable at all.
 *  2. **`CASCADE` is the wrong semantics for some columns.** Nine columns are
 *     deliberately `SET NULL` — `ci.graph_deltas.changed_by_user_id`,
 *     `ci.objects.owner_user_id` and friends — because they attribute a row
 *     that belongs to *someone else*. Blanket-cascading them would delete other
 *     people's data. The purge has to distinguish, which means reading each
 *     constraint's intent rather than overwriting it.
 *  3. **Foreign keys do not cover the data anyway.** Fourteen user-scoped tables
 *     have no foreign key to `ci.users` at all, `ci_search.embeddings`,
 *     `ci_search.vectors` and `ci.browser_activity` among them. A cascade would
 *     report success and leave every one of those rows in place — the worst
 *     possible outcome, because it looks like deletion. Only an explicit plan can
 *     reach them.
 *  4. **The migration itself is the risky part.** Rewriting the constraints means
 *     `DROP CONSTRAINT` + `ADD CONSTRAINT` on every child, and each `ADD` takes a
 *     lock and revalidates the whole table — a long, lock-heavy migration on a
 *     live appliance, to enable an operation we would then never want to run in
 *     one shot.
 *
 * ## Why the plan is discovered instead of written down
 *
 * A hand-maintained list of tables is wrong the day someone adds the next one,
 * and it fails *silently* — the purge succeeds and the data stays. So the plan is
 * derived from the live catalog on every run: new user-scoped tables are covered
 * the day they land. What is hand-written is only the *policy* (below), and a
 * test pins today's classification so a schema change shows up as a diff.
 *
 * ## The rules
 *
 * - A column with `NO ACTION`/`RESTRICT`/`CASCADE`, or with no FK at all, scopes
 *   rows that belong to the account: they are deleted.
 * - A `SET NULL` column is deleted **only if it is the sole user reference on its
 *   table** — that is what tells us the row belongs to this account rather than
 *   merely mentioning it. `ci.entities` and `ci.relationships` qualify (they are
 *   the user's memories and graph edges, owned solely via `owner_user_id`);
 *   `ci.receipts.owner_user_id` does not, because `ci.receipts.user_id` already
 *   owns the row.
 * - A `SET NULL` column named for who made or changed a row (`updated_by`,
 *   `changed_by_user_id`) is never ownership, even when it is the only user
 *   reference on its table: it is nulled. `ci.job_settings` and
 *   `ci.outbound_settings` are appliance-wide rows whose `updated_by` says which
 *   administrator last changed them. Deleting them with that administrator put
 *   every job control and outbound switch back to its default, so a crash-report
 *   upload they had switched off came back on for everyone else.
 * - A user reference **on `ci.users` itself** is never a delete root. Treating
 *   `ci.users.created_by` as one would delete every account this user created.
 * - Tables that are not user-scoped but hold a blocking (`NO ACTION`/`RESTRICT`)
 *   reference *into* the doomed rows are deleted too, scoped through their
 *   parent. Three exist today — `hbpe.l1_event_cluster`, `hbpe.l2_content_cluster`
 *   and `ci_search.entity_tag` — and without this the purge fails part-way.
 * - Blocking references *between* two user-scoped tables are handled by ordering
 *   (child before parent) rather than by a scoped delete, so a purge can never
 *   remove a row owned by a different account. If a cross-account reference does
 *   block a delete, Postgres raises and the job stops with the constraint name —
 *   deliberately louder than deleting someone else's row.
 */
export function buildPurgePlan(input: {
  userColumns: UserRefColumn[];
  edges: FkEdge[];
  /** Defaults to `ci.users`. Injectable so tests can build small fixtures. */
  usersTable?: TableRef;
}): PurgePlan {
  const users = input.usersTable ?? { schema: 'ci', table: 'users' };
  const usersKey = tableKey(users);
  const warnings: string[] = [];

  const edges = [...input.edges].sort((a, b) => a.constraintName.localeCompare(b.constraintName));
  const userColumns = [...input.userColumns].sort(
    (a, b) => tableKey(a).localeCompare(tableKey(b)) || a.column.localeCompare(b.column),
  );

  // ── 1. Classify every user reference as "owns the row" or "mentions the row" ──

  const columnsByTable = new Map<string, UserRefColumn[]>();

  for (const column of userColumns) {
    const existing = columnsByTable.get(tableKey(column));

    if (existing) {
      existing.push(column);
    } else {
      columnsByTable.set(tableKey(column), [column]);
    }
  }

  const roots: UserRefColumn[] = [];
  const detached: Array<{ column: UserRefColumn; reason: string }> = [];

  for (const column of userColumns) {
    // A reference on ci.users is always nulled, never followed. `created_by`
    // points at the account that provisioned another account: deleting through
    // it would take out unrelated, live users.
    if (tableKey(column) === usersKey) {
      detached.push({ column, reason: `${column.column} attributes a different account's row` });

      continue;
    }

    if (column.deleteAction === 'n' || column.deleteAction === 'd') {
      if (PROVENANCE_COLUMN.test(column.column)) {
        detached.push({ column, reason: `${column.column} records who changed the row, not whose it is` });

        continue;
      }

      const ownedByAnotherColumn = (columnsByTable.get(tableKey(column)) ?? []).some(
        (other) => other.column !== column.column && other.deleteAction !== 'n' && other.deleteAction !== 'd',
      );

      if (ownedByAnotherColumn) {
        detached.push({
          column,
          reason: `ON DELETE SET NULL, and ${tableKey(column)} is owned through another column`,
        });

        continue;
      }
    }

    roots.push(column);
  }

  // ── 2. Walk out to tables that block the delete without being user-scoped ──

  interface DeleteTarget {
    target: TableRef;
    scope: PurgeScope;
    reason: string;
  }

  const deleteTargets: DeleteTarget[] = roots.map((column) => ({
    target: { schema: column.schema, table: column.table },
    scope: { kind: 'owned', column: column.column },
    reason:
      column.deleteAction === null
        ? `user-scoped by convention (${column.column}, no foreign key to ${usersKey})`
        : `user-scoped by ${column.constraintName ?? column.column} (ON DELETE ${describeAction(column.deleteAction)})`,
  }));

  const rootTableKeys = new Set(deleteTargets.map((target) => tableKey(target.target)));
  const queue = [...deleteTargets];
  const followedConstraints = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;

    const blocking = edges.filter(
      (edge) =>
        (edge.deleteAction === 'a' || edge.deleteAction === 'r') &&
        edge.parentSchema === current.target.schema &&
        edge.parentTable === current.target.table &&
        // Self-references are flattened by a null step instead (step 3).
        tableKey({ schema: edge.childSchema, table: edge.childTable }) !== tableKey(current.target) &&
        // ci.users is never deleted through: its references into purged rows are
        // nulled for this account (step 3), and another account pointing there
        // (`ci.users.entity_id` at this account's entities) must fail loudly on
        // the foreign key rather than have its account row deleted.
        tableKey({ schema: edge.childSchema, table: edge.childTable }) !== usersKey &&
        // A user-scoped child is deleted by its own root scope; ordering (step 4)
        // guarantees it happens first. Scoping it through the parent instead
        // could delete a different account's row.
        !rootTableKeys.has(tableKey({ schema: edge.childSchema, table: edge.childTable })) &&
        !followedConstraints.has(edge.constraintName),
    );

    for (const edge of blocking) {
      followedConstraints.add(edge.constraintName);

      const dependent: DeleteTarget = {
        target: { schema: edge.childSchema, table: edge.childTable },
        scope: {
          kind: 'referencesPurged',
          column: edge.childColumn,
          parent: {
            schema: current.target.schema,
            table: current.target.table,
            column: edge.parentColumn,
          },
          parentScope: current.scope,
        },
        reason: `blocks ${tableKey(current.target)} via ${edge.constraintName} (ON DELETE ${describeAction(edge.deleteAction)})`,
      };

      deleteTargets.push(dependent);
      queue.push(dependent);
    }
  }

  // ── 3. Break references we must not follow, before anything is deleted ──

  const nullSteps: PurgeStep[] = [];

  // Self-referencing hierarchies (ci.messages.parent_message_id,
  // ci.threads.parent_thread_id, ci.objects.parent_object_id). Without this a
  // batch can delete a parent row while a child still points at it; flattening
  // first makes every batch order safe. Rows belonging to other accounts that
  // pointed into the doomed set are nulled too — they have to be, or their
  // foreign key breaks.
  for (const target of deleteTargets) {
    const selfEdges = edges.filter(
      (edge) =>
        (edge.deleteAction === 'a' || edge.deleteAction === 'r') &&
        edge.childSchema === target.target.schema &&
        edge.childTable === target.target.table &&
        edge.parentSchema === target.target.schema &&
        edge.parentTable === target.target.table,
    );

    for (const edge of selfEdges) {
      nullSteps.push({
        kind: 'null',
        id: `flatten:${tableKey(target.target)}:${edge.childColumn}`,
        target: target.target,
        column: edge.childColumn,
        scope: {
          kind: 'referencesPurged',
          column: edge.childColumn,
          parent: { ...target.target, column: edge.parentColumn },
          parentScope: target.scope,
        },
        reason: `self-referencing hierarchy (${edge.constraintName}) flattened so batches can delete in any order`,
      });
    }
  }

  // References pointing *out* of ci.users into rows we are about to delete —
  // `ci.users.entity_id` is one, and it makes users<->entities a cycle that
  // nothing else can break. Nulled on EVERY account row that points into the
  // doomed rows, not only this account's: another account whose `entity_id`
  // names one of this account's entities would otherwise fail the entities
  // delete on the foreign key on every retry, and the purge would never finish.
  // Nulling it is what `ON DELETE SET NULL` would do; the other account keeps
  // its row and loses only a pointer to data that is no longer there.
  for (const edge of edges) {
    if (edge.deleteAction !== 'a' && edge.deleteAction !== 'r') {
      continue;
    }

    if (tableKey({ schema: edge.childSchema, table: edge.childTable }) !== usersKey) {
      continue;
    }

    const parentKey = tableKey({ schema: edge.parentSchema, table: edge.parentTable });

    for (const target of deleteTargets.filter((candidate) => tableKey(candidate.target) === parentKey)) {
      nullSteps.push({
        kind: 'null',
        id: `detach:${usersKey}:${edge.childColumn}->${parentKey}:${scopeId(target.scope)}`,
        target: users,
        column: edge.childColumn,
        scope: {
          kind: 'referencesPurged',
          column: edge.childColumn,
          parent: { ...target.target, column: edge.parentColumn },
          parentScope: target.scope,
        },
        reason: `${edge.constraintName} points from ${usersKey} into purged rows`,
      });
    }
  }

  // ── 4. Order the deletes: children before parents ──

  const ordered = orderDeletes(deleteTargets, edges, warnings);

  const deleteSteps: PurgeStep[] = ordered.map((target) => ({
    kind: 'delete',
    id: `delete:${tableKey(target.target)}:${scopeId(target.scope)}`,
    target: target.target,
    scope: target.scope,
    reason: target.reason,
  }));

  // ── 5. Detach what survives, then the account row itself ──

  const detachSteps: PurgeStep[] = detached.map(({ column, reason }) => ({
    kind: 'null',
    id: `detach:${tableKey(column)}:${column.column}`,
    target: { schema: column.schema, table: column.table },
    column: column.column,
    scope: { kind: 'owned', column: column.column },
    reason,
  }));

  const steps: PurgeStep[] = [
    ...dedupeById(nullSteps),
    ...deleteSteps,
    ...detachSteps,
    { kind: 'deleteUser', id: `delete:${usersKey}`, target: users },
  ];

  return {
    steps,
    purgedTables: [...new Set(ordered.map((target) => tableKey(target.target)))].sort(),
    detachedColumns: detached.map(({ column }) => `${tableKey(column)}.${column.column}`).sort(),
    warnings,
  };
}

/**
 * Topological sort over the tables being deleted: a table that references
 * another must be emptied first.
 *
 * `NO ACTION`/`RESTRICT` edges make the order *mandatory* — get it wrong and
 * Postgres raises. `CASCADE` edges make it *preferable*: deleting the child
 * explicitly keeps it inside the batch loop, where letting the parent's delete
 * cascade would fire one unbounded delete instead. So both are used as
 * ordering constraints, and cascade edges are dropped first if they turn out to
 * create a cycle that the mandatory ones do not. `SET NULL`/`SET DEFAULT` edges
 * are the cheapest hint of all, tried first and dropped first.
 */
function orderDeletes(
  targets: Array<{ target: TableRef; scope: PurgeScope; reason: string }>,
  edges: FkEdge[],
  warnings: string[],
): Array<{ target: TableRef; scope: PurgeScope; reason: string }> {
  const present = new Set(targets.map((target) => tableKey(target.target)));

  const constraintEdges = (actions: FkDeleteActionSet) =>
    edges
      .filter((edge) => actions.has(edge.deleteAction))
      .map((edge) => ({
        child: tableKey({ schema: edge.childSchema, table: edge.childTable }),
        parent: tableKey({ schema: edge.parentSchema, table: edge.parentTable }),
      }))
      .filter((edge) => edge.child !== edge.parent && present.has(edge.child) && present.has(edge.parent));

  const mandatory = new Set<FkDeleteActionSetMember>(['a', 'r']);
  const preferred = new Set<FkDeleteActionSetMember>(['a', 'r', 'c']);
  const cheapest = new Set<FkDeleteActionSetMember>(['a', 'r', 'c', 'n', 'd']);

  // `SET NULL` children first too, when that makes no cycle: a parent deleted
  // first has Postgres rewrite every child row that points at it, only for the
  // purge to delete those rows a step later. `ci.position` is the one that
  // matters: each `ci.entities` delete used to null the account's own positions
  // in compressed chunks (decompressing them) before they were deleted, which
  // their `user_id` segment lets the purge do cheaply. Dropped silently on a
  // cycle, as it changes only the cost, never what is deleted.
  let sorted =
    kahn([...present].sort(), constraintEdges(cheapest)) ??
    kahn([...present].sort(), constraintEdges(preferred));

  if (!sorted) {
    // A cascade edge closed a loop. Drop the soft constraints and retry — the
    // cascade still fires, it just is not batched for that one table.
    sorted = kahn([...present].sort(), constraintEdges(mandatory));

    if (sorted) {
      warnings.push(
        'Cascade ordering hints dropped: a CASCADE edge formed a cycle. Deletes remain correct but one table will cascade unbatched.',
      );
    }
  }

  if (!sorted) {
    warnings.push(
      'Foreign-key cycle among user-scoped tables: no safe delete order exists. Purge will not run — break the cycle with a nullable column.',
    );

    return targets;
  }

  const rank = new Map(sorted.map((table, index) => [table, index]));

  return [...targets].sort(
    (a, b) =>
      (rank.get(tableKey(a.target)) ?? 0) - (rank.get(tableKey(b.target)) ?? 0) ||
      scopeId(a.scope).localeCompare(scopeId(b.scope)),
  );
}

type FkDeleteActionSetMember = 'a' | 'r' | 'c' | 'n' | 'd';
type FkDeleteActionSet = Set<FkDeleteActionSetMember>;

/** Kahn's algorithm. Returns `null` when the graph has a cycle. */
function kahn(nodes: string[], edges: Array<{ child: string; parent: string }>): string[] | null {
  const indegree = new Map(nodes.map((node) => [node, 0]));
  const dependents = new Map<string, string[]>(nodes.map((node) => [node, []]));

  for (const edge of edges) {
    dependents.get(edge.child)!.push(edge.parent);
    indegree.set(edge.parent, (indegree.get(edge.parent) ?? 0) + 1);
  }

  // Sorted ready-set, so the same schema always yields the same plan.
  const ready = nodes.filter((node) => indegree.get(node) === 0).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const node = ready.shift()!;

    order.push(node);

    for (const dependent of dependents.get(node) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;

      indegree.set(dependent, next);

      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  return order.length === nodes.length ? order : null;
}

function dedupeById(steps: PurgeStep[]): PurgeStep[] {
  const seen = new Set<string>();

  return steps.filter((step) => (seen.has(step.id) ? false : (seen.add(step.id), true)));
}

function tableKey(ref: { schema: string; table: string }): string {
  return `${ref.schema}.${ref.table}`;
}

function scopeId(scope: PurgeScope): string {
  return scope.kind === 'owned'
    ? scope.column
    : `${scope.column}->${scope.parent.schema}.${scope.parent.table}.${scope.parent.column}`;
}

function describeAction(action: FkDeleteActionSetMember): string {
  switch (action) {
    case 'a':
      return 'NO ACTION';
    case 'r':
      return 'RESTRICT';
    case 'c':
      return 'CASCADE';
    case 'n':
      return 'SET NULL';
    case 'd':
      return 'SET DEFAULT';
  }
}
