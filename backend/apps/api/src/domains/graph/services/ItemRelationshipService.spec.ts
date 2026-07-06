import { ItemRelationshipService, type ItemRelationshipInputDto } from './ItemRelationshipService';

const USER = '00000000-0000-0000-0000-0000000000aa';

/**
 * A fake ItemRelationshipEntity repository that simulates the set-based
 * `INSERT ... ON CONFLICT (edge tuple) DO NOTHING RETURNING id`: an in-memory
 * store keyed by (user_id, from-triple, to-triple, relation) drops any row whose
 * key is already present, so `.execute()`'s `raw` carries ONLY the rows that
 * actually inserted — exactly what the service counts as `inserted`.
 */
function makeFakeRepo() {
  const store = new Set<string>();
  const key = (r: Record<string, unknown>) =>
    [
      r.userId,
      r.fromSourceType,
      r.fromSourceSystem,
      r.fromSourceId,
      r.toSourceType,
      r.toSourceSystem,
      r.toSourceId,
      r.relation,
    ].join('||');

  const repo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (row: any) => ({ ...row }),
    metadata: { target: 'ItemRelationshipEntity' },
    createQueryBuilder: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let rows: any[] = [];
      const qb: Record<string, unknown> = {};
      Object.assign(qb, {
        insert: () => qb,
        into: () => qb,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        values: (v: any[]) => {
          rows = v;

          return qb;
        },
        onConflict: () => qb,
        returning: () => qb,
        execute: async () => {
          const raw: Array<{ id: string }> = [];
          for (const row of rows) {
            const k = key(row);
            if (store.has(k)) {continue;} // ON CONFLICT DO NOTHING

            store.add(k);
            raw.push({ id: row.id });
          }

          return { raw };
        },
      });

      return qb;
    },
  };

  return { repo, store };
}

function edge(overrides: Partial<ItemRelationshipInputDto> = {}): ItemRelationshipInputDto {
  return {
    fromSourceType: 'ci-import-tools',
    fromSourceSystem: 'gmail',
    fromSourceId: 'email-1',
    toSourceType: 'ci-import-tools',
    toSourceSystem: 'gmail',
    toSourceId: 'attachment-1',
    relation: 'has_attachment',
    ...overrides,
  };
}

function makeService() {
  const { repo, store } = makeFakeRepo();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ItemRelationshipService(repo as any);

  return { service, store };
}

describe('ItemRelationshipService.createMany', () => {
  it('inserts new item↔item edges and reports the inserted count', async () => {
    const { service } = makeService();

    const result = await service.createMany({ userId: USER }, [
      edge({ toSourceId: 'attachment-1' }),
      edge({ toSourceId: 'attachment-2' }),
    ]);

    expect(result).toEqual({ inserted: 2, skipped: 0 });
  });

  it('dedups on re-send: the second identical batch inserts nothing', async () => {
    const { service, store } = makeService();

    const batch = [edge({ toSourceId: 'attachment-1' }), edge({ toSourceId: 'attachment-2' })];

    const first = await service.createMany({ userId: USER }, batch);
    expect(first).toEqual({ inserted: 2, skipped: 0 });

    const second = await service.createMany({ userId: USER }, batch);
    // Re-send of the same triples: all deduped by the unique arbiter.
    expect(second).toEqual({ inserted: 0, skipped: 2 });

    // Only two distinct edges ever landed.
    expect(store.size).toBe(2);
  });

  it('collapses duplicate edges within a single batch (counted as skipped)', async () => {
    const { service, store } = makeService();

    const result = await service.createMany({ userId: USER }, [
      edge({ toSourceId: 'attachment-1' }),
      edge({ toSourceId: 'attachment-1' }), // exact duplicate within the batch
      edge({ toSourceId: 'attachment-2' }),
    ]);

    expect(result).toEqual({ inserted: 2, skipped: 1 });
    expect(store.size).toBe(2);
  });

  it('scopes dedup per user: the same edge for a different owner is a fresh insert', async () => {
    const { service } = makeService();
    const OTHER = '00000000-0000-0000-0000-0000000000bb';

    const first = await service.createMany({ userId: USER }, [edge()]);
    const second = await service.createMany({ userId: OTHER }, [edge()]);

    expect(first).toEqual({ inserted: 1, skipped: 0 });
    expect(second).toEqual({ inserted: 1, skipped: 0 });
  });

  it('treats a different relation between the same items as a distinct edge', async () => {
    const { service } = makeService();

    const a = await service.createMany({ userId: USER }, [edge({ relation: 'has_attachment' })]);
    const b = await service.createMany({ userId: USER }, [edge({ relation: 'in_album' })]);

    expect(a).toEqual({ inserted: 1, skipped: 0 });
    expect(b).toEqual({ inserted: 1, skipped: 0 });
  });

  it('returns zero counts for an empty batch', async () => {
    const { service } = makeService();
    expect(await service.createMany({ userId: USER }, [])).toEqual({ inserted: 0, skipped: 0 });
  });
});
