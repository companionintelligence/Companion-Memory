/**
 * An in-memory `ci.entity_identifiers`, shaped for `EntityIdentifierService`'s
 * repository, for specs that need to say what the service WROTE rather than
 * which methods it called.
 *
 * Rows are keyed on the table's real unique tuple (owner_user_id, kind,
 * value_normalized), so first-writer-wins holds: an insert whose tuple is taken
 * is ignored, the way `ON CONFLICT DO NOTHING` ignores it. Every statement that
 * could change the table is appended to `writes` — including an ignored insert,
 * which is still a write the service attempted — so "nothing was written" is
 * `writes` being empty, not an inference from mocks.
 *
 * It answers only the statements the service issues: the insert builder,
 * `find` / `findOne` / `update` / `delete` on column equality or `In(...)` (as
 * `listForEntities` passes it), and the `(kind, value_normalized) IN (...)`
 * lookup behind `findEntityIdsByIdentifiers`. Anything else throws rather than
 * being answered wrongly.
 *
 * Here rather than in the graph domain because the person resolver's specs need
 * it as much as the service's, and shared test machinery lives above the
 * domains (see `.dependency-cruiser.mjs`, `no-cross-domain-internals`).
 */
import { FindOperator } from 'typeorm';

export interface EntityIdentifierRow {
  ownerUserId: string;
  entityId: string;
  kind: string;
  valueNormalized: string;
  rawValue?: string | null;
  label?: string | null;
  isPrimary?: boolean;
  source?: string | null;
  verifiedAt?: Date | null;
}

export type EntityIdentifierWrite =
  | { op: 'insert'; row: EntityIdentifierRow; ignored: boolean }
  | { op: 'update'; where: Record<string, unknown>; patch: Record<string, unknown> }
  | { op: 'delete'; where: Record<string, unknown> };

type Criteria = Record<string, unknown>;

const tupleOf = (row: { ownerUserId: string; kind: string; valueNormalized: string }) =>
  `${row.ownerUserId}|${row.kind}|${row.valueNormalized}`;

function matches(row: EntityIdentifierRow, criteria: Criteria): boolean {
  return Object.entries(criteria).every(([column, expected]) => {
    const actual = (row as unknown as Record<string, unknown>)[column];

    if (expected instanceof FindOperator && expected.type === 'in' && Array.isArray(expected.value)) {
      return (expected.value as unknown[]).includes(actual);
    }

    if (expected !== null && typeof expected === 'object') {
      // Any other operator (Not, Like, ...) is not modelled: refuse it instead
      // of comparing an object by identity and matching nothing.
      throw new Error(`in-memory ci.entity_identifiers: unsupported criteria on "${column}"`);
    }

    return actual === expected;
  });
}

export function makeInMemoryEntityIdentifiers(seed: EntityIdentifierRow[] = []) {
  const rows: EntityIdentifierRow[] = seed.map((row) => ({ ...row }));
  const writes: EntityIdentifierWrite[] = [];

  const insert = (row: EntityIdentifierRow): EntityIdentifierRow | null => {
    // `verifiedAt` arrives as a `() => 'now()'` SQL fragment; store a date.
    const stored = { ...row, verifiedAt: typeof row.verifiedAt === 'function' ? new Date() : row.verifiedAt };
    const ignored = rows.some((existing) => tupleOf(existing) === tupleOf(stored));

    writes.push({ op: 'insert', row: stored, ignored });
    if (ignored) {
      return null;
    }

    rows.push(stored);

    return stored;
  };

  const createQueryBuilder = () => {
    let pending: EntityIdentifierRow[] = [];
    const builder = {
      insert: () => builder,
      into: () => builder,
      values: (value: EntityIdentifierRow | EntityIdentifierRow[]) => {
        pending = Array.isArray(value) ? value : [value];

        return builder;
      },
      orIgnore: () => builder,
      returning: () => builder,
      execute: async () => {
        const inserted = pending.map(insert).filter((row) => row != null);
        pending = [];

        return { raw: inserted, identifiers: [] };
      },
    };

    return builder;
  };

  const repository = {
    create: (row: EntityIdentifierRow) => ({ ...row }),
    createQueryBuilder,
    find: async ({ where }: { where: Criteria }) => rows.filter((row) => matches(row, where)),
    findOne: async ({ where }: { where: Criteria }) => rows.find((row) => matches(row, where)) ?? null,
    update: async (where: Criteria, patch: Record<string, unknown>) => {
      writes.push({ op: 'update', where, patch });
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) {
        Object.assign(row, patch);
      }

      return { affected: hit.length };
    },
    delete: async (criteria: Criteria | Criteria[]) => {
      let affected = 0;
      for (const where of Array.isArray(criteria) ? criteria : [criteria]) {
        writes.push({ op: 'delete', where });
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (matches(rows[index]!, where)) {
            rows.splice(index, 1);
            affected += 1;
          }
        }
      }

      return { affected };
    },
    manager: {
      query: async (sql: string, params: unknown[]) => {
        if (!/FROM ci\.entity_identifiers/.test(sql) || !/\(kind, value_normalized\) IN/.test(sql)) {
          throw new Error(`in-memory ci.entity_identifiers cannot answer: ${sql}`);
        }

        const [ownerUserId, ...pairs] = params as string[];
        const wanted = new Set<string>();
        for (let index = 0; index < pairs.length; index += 2) {
          wanted.add(`${ownerUserId}|${pairs[index]}|${pairs[index + 1]}`);
        }

        return rows
          .filter((row) => wanted.has(tupleOf(row)))
          .map((row) => ({ kind: row.kind, value_normalized: row.valueNormalized, entity_id: row.entityId }));
      },
    },
    // EntityIdentifierEntity's persisted columns; only sizes upsertForEntities' chunks.
    metadata: { columns: { length: 10 } },
  };

  return { repository, rows, writes };
}

/** The logger shape `EntityIdentifierService` takes, silenced. */
export const silentLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
