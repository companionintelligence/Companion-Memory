import { DEFERRABLE_INDEXES } from './deferrableIndexes';

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
      expect(name).not.toMatch(/_source_identity_uniq$/);
      expect(name).not.toMatch(/_pkey$/);
    }
  });
});
