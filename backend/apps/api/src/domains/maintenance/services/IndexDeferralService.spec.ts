import { DEFERRABLE_INDEXES, IndexDeferralService } from './IndexDeferralService';

const logger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

/**
 * Minimal fake DataSource. `metaByIndex` maps "schema.name" to the row the
 * pg_indexes lookup would return (or undefined => not found). Every DROP/CREATE
 * is recorded so we can assert what the service tried to touch.
 */
function makeDataSource(
  metaByIndex: Record<string, { indexdef: string; is_unique: boolean; is_constraint: boolean }>,
) {
  const executed: string[] = [];

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM pg_indexes')) {
      const [schema, name] = params as [string, string];
      const meta = metaByIndex[`${schema}.${name}`];

      return meta ? [meta] : [];
    }

    executed.push(sql);

    return [];
  });

  return { dataSource: { query } as never, query, executed };
}

function service(ds: { dataSource: never }) {
  return new IndexDeferralService(ds.dataSource, logger as never);
}

describe('DEFERRABLE_INDEXES registry', () => {
  it('registers the ci_search.embeddings HNSW index (search-perf-hnsw-index P0)', () => {
    const hnsw = DEFERRABLE_INDEXES.find(
      (i) => i.schema === 'ci_search' && i.name === 'embeddings_embedding_hnsw_idx',
    );

    expect(hnsw).toBeDefined();
    expect(hnsw?.note).toMatch(/hnsw/i);
    expect(hnsw?.note).toMatch(/vector_cosine_ops/);
  });

  it('does NOT register the cheap btree(user_id) index (not worth deferring)', () => {
    const userIdIdx = DEFERRABLE_INDEXES.find((i) => i.name === 'embeddings_user_id_idx');

    expect(userIdIdx).toBeUndefined();
  });

  it('never lists a provenance-unique or primary-key index', () => {
    for (const { name } of DEFERRABLE_INDEXES) {
      expect(name).not.toMatch(/_source_triple_uniq$/);
      expect(name).not.toMatch(/_pkey$/);
    }
  });
});

describe('IndexDeferralService.dropDeferredIndexes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('drops the HNSW index and returns its captured recreate definition', async () => {
    const def =
      'CREATE INDEX embeddings_embedding_hnsw_idx ON ci_search.embeddings USING hnsw (embedding vector_cosine_ops)';
    const ds = makeDataSource({
      'ci_search.embeddings_embedding_hnsw_idx': {
        indexdef: def,
        is_unique: false,
        is_constraint: false,
      },
    });

    const result = await service(ds).dropDeferredIndexes();

    const droppedHnsw = result.dropped.find((d) => d.name === 'embeddings_embedding_hnsw_idx');
    expect(droppedHnsw?.definition).toBe(def);
    expect(
      ds.executed.some((sql) => /DROP INDEX IF EXISTS "ci_search"."embeddings_embedding_hnsw_idx"/.test(sql)),
    ).toBe(true);
  });

  it('refuses to drop a unique/constraint index even if it appears in the list', async () => {
    // Pretend the HNSW entry resolves to a unique index — the hard guard must skip it.
    const ds = makeDataSource({
      'ci_search.embeddings_embedding_hnsw_idx': {
        indexdef: 'CREATE UNIQUE INDEX ...',
        is_unique: true,
        is_constraint: false,
      },
    });

    const result = await service(ds).dropDeferredIndexes();

    expect(result.dropped.find((d) => d.name === 'embeddings_embedding_hnsw_idx')).toBeUndefined();
    expect(result.skipped.find((s) => s.name === 'embeddings_embedding_hnsw_idx')?.reason).toMatch(
      /refusing to drop/i,
    );
    expect(ds.executed.some((sql) => /DROP INDEX/.test(sql))).toBe(false);
  });

  it('skips indexes that are not present in the database', async () => {
    const ds = makeDataSource({}); // nothing found

    const result = await service(ds).dropDeferredIndexes();

    expect(result.dropped).toHaveLength(0);
    expect(result.skipped.every((s) => s.reason === 'not found')).toBe(true);
    expect(result.skipped.length).toBe(DEFERRABLE_INDEXES.length);
  });
});

describe('IndexDeferralService.recreateDeferredIndexes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('re-runs each captured CREATE statement independently', async () => {
    const ds = makeDataSource({});
    const dropped = [
      { schema: 'ci_search', name: 'embeddings_embedding_hnsw_idx', definition: 'CREATE INDEX a ...' },
      { schema: 'ci', name: 'messages_embedding_idx', definition: 'CREATE INDEX b ...' },
    ];

    const result = await service(ds).recreateDeferredIndexes(dropped);

    expect(result.recreated).toEqual(['embeddings_embedding_hnsw_idx', 'messages_embedding_idx']);
    expect(result.failed).toHaveLength(0);
    expect(ds.executed).toEqual(['CREATE INDEX a ...', 'CREATE INDEX b ...']);
  });
});
