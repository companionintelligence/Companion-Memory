/**
 * Types for the account-data purge planner.
 *
 * The planner is a pure function over the Postgres catalog: it takes the set of
 * columns that point at `ci.users` (plus the foreign-key graph between every
 * table) and returns an ordered list of steps that removes one account's data
 * without ever raising a foreign-key violation. Keeping it pure is what makes a
 * destructive, hard-to-rehearse operation testable — every ordering rule below
 * is asserted against fixture catalogs in `__tests__/purgePlan.spec.ts`.
 */

/**
 * `pg_constraint.confdeltype` — what Postgres does to the referencing row when
 * the referenced row is deleted.
 *
 * - `a` NO ACTION (the default when a migration writes no `ON DELETE` clause)
 * - `r` RESTRICT
 * - `c` CASCADE
 * - `n` SET NULL
 * - `d` SET DEFAULT
 */
export type FkDeleteAction = 'a' | 'r' | 'c' | 'n' | 'd';

/** A column that scopes rows to a user. */
export interface UserRefColumn {
  schema: string;
  table: string;
  column: string;
  /**
   * The FK's delete action, or `null` when this column is user-scoped **by
   * naming convention only** — a `uuid` column called `user_id`/`owner_user_id`
   * with no foreign key to `ci.users` at all.
   *
   * That second kind is not a curiosity: at the time of writing fourteen tables
   * are in it, including `ci_search.embeddings`, `ci_search.vectors` and
   * `ci.browser_activity` — i.e. the vector form of the user's memories and
   * their browsing capture. A purge that trusted foreign keys alone would
   * report success and leave every one of those rows in place.
   */
  deleteAction: FkDeleteAction | null;
  /** `null` for convention-scoped columns. */
  constraintName: string | null;
}

/** One single-column foreign key, as read from `pg_constraint`. */
export interface FkEdge {
  constraintName: string;
  childSchema: string;
  childTable: string;
  childColumn: string;
  parentSchema: string;
  parentTable: string;
  /** The referenced column on the parent — usually, but not always, `id`. */
  parentColumn: string;
  deleteAction: FkDeleteAction;
}

/**
 * How rows are selected for a step. Rendered to SQL by the executor; kept
 * declarative here so the planner stays free of string building.
 */
export type PurgeScope =
  /** `"<column>" = $1` — the account being purged. */
  | { kind: 'owned'; column: string }
  /**
   * `"<column>" IN (SELECT "<parent.column>" FROM <parent> WHERE <parentScope>)`
   * — rows that are not user-scoped themselves but point at rows that are, via a
   * reference Postgres will not let us break (NO ACTION / RESTRICT).
   */
  | {
      kind: 'referencesPurged';
      column: string;
      parent: { schema: string; table: string; column: string };
      parentScope: PurgeScope;
    };

/** A table, schema-qualified. */
export interface TableRef {
  schema: string;
  table: string;
}

export type PurgeStep =
  /**
   * `UPDATE <table> SET "<column>" = NULL WHERE <scope>` — break a reference
   * rather than follow it. Two uses: detaching a `SET NULL` attribution that
   * belongs to a row we are keeping, and flattening a self-referencing
   * hierarchy so the rows underneath it can be deleted in any order.
   */
  | { kind: 'null'; id: string; target: TableRef; column: string; scope: PurgeScope; reason: string }
  /** `DELETE FROM <table> WHERE <scope>`, executed in bounded batches. */
  | { kind: 'delete'; id: string; target: TableRef; scope: PurgeScope; reason: string }
  /** The `ci.users` row itself. Always last; its success is the proof the rest worked. */
  | { kind: 'deleteUser'; id: string; target: TableRef };

export interface PurgePlan {
  steps: PurgeStep[];
  /**
   * Tables whose rows this plan deletes, schema-qualified. Surfaced so the
   * executor can log what a purge actually covered, and so the coverage test
   * can diff it against the live schema.
   */
  purgedTables: string[];
  /**
   * Columns nulled rather than purged, with the reason. These are the honest
   * residue of a purge: an attribution on a row belonging to someone else.
   */
  detachedColumns: string[];
  /**
   * Problems the planner could not resolve. Non-empty means the plan is
   * expected to fail part-way, so the executor refuses to start rather than
   * deleting half an account and stopping.
   */
  warnings: string[];
}
