/**
 * In-memory fakes for the NodeEntity / RelationshipEntity repositories, shaped
 * for GraphIngestService's SET-BASED ingest path (createQueryBuilder + insert()
 * ... onConflict ... returning). These simulate exactly the two operations the
 * service performs against each repository:
 *
 *   - a SELECT built via `.createQueryBuilder(alias).where(...).andWhere(Brackets)`
 *     resolved with `.getMany()`, and
 *   - a batched `.createQueryBuilder().insert().into(...).values(rows)
 *     .onConflict('…').returning(cols).execute()` — DO UPDATE for nodes (a
 *     conflicting row keeps its id and takes the incoming name/description/
 *     properties), DO NOTHING for relationships.
 *
 * The fakes ignore the exact SQL text and instead apply the service's actual
 * idempotency predicate (entities: (owner,type,linkedTable,linkedId); rels:
 * (owner,from,to,type)) to an in-memory row store, so a re-ingest dedups just as
 * Postgres' ON CONFLICT would. That keeps the specs asserting OBSERVABLE ingest
 * behaviour (dedup, mapping, error isolation) rather than a specific statement
 * shape.
 */

interface StoredNode {
  entityId: string;
  entityType: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  linkedTable: string | null;
  linkedId: string | null;
  userId: string;
}

interface StoredRel {
  id: string;
  fromNodeId: string;
  fromNodeType: string;
  toNodeId: string;
  toNodeType: string;
  type: string;
  userId: string;
  properties: Record<string, unknown>;
}

const nodeCoord = (r: {
  userId: string;
  entityType: string;
  linkedTable: string | null;
  linkedId: string | null;
}) => `${r.userId}||${r.entityType}||${r.linkedTable}||${r.linkedId}`;

const relCoord = (r: { userId: string; fromNodeId: string; toNodeId: string; type: string }) =>
  `${r.userId}||${r.fromNodeId}||${r.toNodeId}||${r.type}`;

/**
 * A fake repository over a row store keyed by the service's idempotency
 * coordinates. `failInsert`/`failSelect` let a spec force a batch-level DB error
 * to exercise the error-isolation path. Every inserted row's snapshot is captured
 * in `inserted`, and every refreshed one in `updated`, so specs can assert on
 * what actually landed — including that an unchanged row was left alone.
 */
export function makeFakeNodeRepository(
  opts: { seed?: StoredNode[]; failSelect?: boolean; failInsert?: boolean } = {},
) {
  const store = new Map<string, StoredNode>();
  for (const row of opts.seed ?? []) {
    store.set(nodeCoord(row), row);
  }

  const inserted: StoredNode[] = [];
  const updated: StoredNode[] = [];

  const repo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (row: any) => ({ ...row }),
    // NodeEntity has 10 persisted columns; drives computeChunkSize in the
    // service's batched INSERT (columns.length).
    metadata: { target: 'NodeEntity', columns: { length: 10 } },
    manager: { query: jest.fn().mockResolvedValue([]) },
    // The service calls this both with an alias (existence SELECT) and without
    // (batched INSERT); the alias is irrelevant to the in-memory store.
    createQueryBuilder: () => makeNodeQb(),
  };

  function makeNodeQb() {
    // Collect the OR-predicate coordinates the service's Brackets add, so getMany
    // returns exactly the matching stored rows.
    const wanted: Array<{ userId?: string; entityType: string; linkedTable: string; linkedId: string }> = [];
    let ownerId: string | undefined;
    let insertRows: StoredNode[] | null = null;

    const qb: Record<string, unknown> = {};
    Object.assign(qb, {
      where: (_sql: string, params?: Record<string, unknown>) => {
        if (params?.ownerId) {
          ownerId = params.ownerId as string;
        }

        return qb;
      },
      andWhere: (arg: unknown) => {
        // The service passes a Brackets whose factory calls orWhere with the
        // et_/lt_/li_ params; replay it against a collector to recover coordinates.
        replayBrackets(arg, (params) => {
          for (let i = 0; ; i++) {
            if (!(`et_${i}` in params)) {
              break;
            }

            wanted.push({
              entityType: params[`et_${i}`] as string,
              linkedTable: params[`lt_${i}`] as string,
              linkedId: params[`li_${i}`] as string,
            });
          }
        });

        return qb;
      },
      getMany: async (): Promise<StoredNode[]> => {
        if (opts.failSelect) {
          throw new Error('db unavailable');
        }

        const out: StoredNode[] = [];
        for (const w of wanted) {
          const hit = store.get(`${ownerId}||${w.entityType}||${w.linkedTable}||${w.linkedId}`);
          if (hit) {
            out.push(hit);
          }
        }

        return out;
      },
      insert: () => qb,
      into: () => qb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: (rows: any[]) => {
        insertRows = rows as StoredNode[];

        return qb;
      },
      onConflict: () => qb,
      returning: () => qb,
      execute: async () => {
        if (opts.failInsert) {
          throw new Error('db unavailable');
        }

        const raw: Array<Record<string, unknown>> = [];
        for (const row of insertRows ?? []) {
          const key = nodeCoord(row);
          const current = store.get(key);
          // ON CONFLICT DO UPDATE: the stored row keeps its entity_id (and every
          // reference to it) and takes the incoming content. RETURNING yields
          // the row that actually exists, which is what the service maps keys to.
          const landed = current
            ? { ...current, name: row.name, description: row.description, properties: row.properties }
            : row;

          store.set(key, landed);
          (current ? updated : inserted).push(landed);
          raw.push({
            entity_id: landed.entityId,
            entity_type: landed.entityType,
            linked_table: landed.linkedTable,
            linked_id: landed.linkedId,
          });
        }

        return { raw };
      },
    });

    return qb;
  }

  return { repo, store, inserted, updated };
}

export function makeFakeRelationshipRepository(opts: { failSelect?: boolean; failInsert?: boolean } = {}) {
  const store = new Map<string, StoredRel>();
  const inserted: StoredRel[] = [];

  const repo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (row: any) => ({ ...row }),
    // RelationshipEntity has 14 persisted columns; drives computeChunkSize in
    // the service's batched INSERT (columns.length).
    metadata: { target: 'RelationshipEntity', columns: { length: 14 } },
    createQueryBuilder: () => makeRelQb(),
  };

  function makeRelQb() {
    const wanted: Array<{ fromNodeId: string; toNodeId: string; type: string }> = [];
    let ownerId: string | undefined;
    let insertRows: StoredRel[] | null = null;

    const qb: Record<string, unknown> = {};
    Object.assign(qb, {
      where: (_sql: string, params?: Record<string, unknown>) => {
        if (params?.ownerId) {
          ownerId = params.ownerId as string;
        }

        return qb;
      },
      andWhere: (arg: unknown) => {
        replayBrackets(arg, (params) => {
          for (let i = 0; ; i++) {
            if (!(`rf_${i}` in params)) {
              break;
            }

            wanted.push({
              fromNodeId: params[`rf_${i}`] as string,
              toNodeId: params[`rt_${i}`] as string,
              type: params[`rtype_${i}`] as string,
            });
          }
        });

        return qb;
      },
      getMany: async (): Promise<StoredRel[]> => {
        if (opts.failSelect) {
          throw new Error('db unavailable');
        }

        const out: StoredRel[] = [];
        for (const w of wanted) {
          const hit = store.get(`${ownerId}||${w.fromNodeId}||${w.toNodeId}||${w.type}`);
          if (hit) {
            out.push(hit);
          }
        }

        return out;
      },
      insert: () => qb,
      into: () => qb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: (rows: any[]) => {
        insertRows = rows as StoredRel[];

        return qb;
      },
      onConflict: () => qb,
      execute: async () => {
        if (opts.failInsert) {
          throw new Error('db unavailable');
        }

        for (const row of insertRows ?? []) {
          const key = relCoord(row);
          if (store.has(key)) {
            continue;
          } // ON CONFLICT DO NOTHING

          store.set(key, row);
          inserted.push(row);
        }

        return { raw: [] };
      },
    });

    return qb;
  }

  return { repo, store, inserted };
}

/**
 * Replay a TypeORM Brackets object: invoke its whereFactory with a collector that
 * captures the params passed to each orWhere call. The service builds its
 * existence SELECTs with `new Brackets((qb) => coords.forEach(... qb.orWhere(sql, params)))`.
 */
function replayBrackets(arg: unknown, onParams: (params: Record<string, unknown>) => void): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory = (arg as any)?.whereFactory;
  if (typeof factory !== 'function') {
    return;
  }

  const collector = {
    orWhere: (_sql: string, params?: Record<string, unknown>) => {
      if (params) {
        onParams(params);
      }

      return collector;
    },
  };
  factory(collector);
}
