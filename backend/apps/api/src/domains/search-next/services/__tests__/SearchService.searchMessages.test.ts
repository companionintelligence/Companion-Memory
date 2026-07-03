import type { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';

import type { EmbeddingEntity } from '../../entities/EmbeddingEntity';
import type { VectorEntity } from '../../entities/VectorEntity';
import { SearchService } from '../SearchService';

/**
 * Focused unit test for the naive-RAG message channel (`searchMessages`). We assert
 * the cosine-distance floor added for gap G5 (memory-and-search plan §3/§5): the SQL
 * must gate on `embedding <=> query`, the floor must default to 0.5 (matching semantic
 * mode) and be overridable, and top-K must be corpus-tunable. The repo `query` is
 * stubbed so no Postgres is required.
 */
const CONTEXT = { userId: 'user-1' } as unknown as UserServiceContext;

function makeService() {
  const query = jest.fn().mockResolvedValue([{ entity_id: 'm1', score: '0.9' }]);
  const embeddingRepo = { query } as unknown as Repository<EmbeddingEntity>;
  const vectorRepo = { query: jest.fn() } as unknown as Repository<VectorEntity>;
  const embeddingGenerationService = {
    generateEmbeddingString: jest.fn().mockResolvedValue('[0.1,0.2]'),
  } as unknown as EmbeddingGenerationService;

  const service = new SearchService(embeddingRepo, embeddingGenerationService, vectorRepo);

  return { service, query, embeddingGenerationService };
}

describe('SearchService.searchMessages', () => {
  it('gates results with a cosine-distance floor in the SQL', async () => {
    const { service, query } = makeService();

    await service.searchMessages(CONTEXT, 'where does priya live');

    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/\(embedding <=> \$2\) < \$3::double precision/);
  });

  it('defaults the floor to 0.5 (matching semantic mode) and K to 10', async () => {
    const { service, query } = makeService();

    await service.searchMessages(CONTEXT, 'where does priya live');

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/LIMIT 10/);
    expect(params).toEqual(['user-1', '[0.1,0.2]', 0.5]);
  });

  it('honours an explicit floor and top-K override for per-corpus tuning', async () => {
    const { service, query } = makeService();

    await service.searchMessages(CONTEXT, 'q', 25, 0.35);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/LIMIT 25/);
    expect(params).toEqual(['user-1', '[0.1,0.2]', 0.35]);
  });

  it('maps rows to {id, score} numbers', async () => {
    const { service } = makeService();

    const result = await service.searchMessages(CONTEXT, 'q');

    expect(result).toEqual([{ id: 'm1', score: 0.9 }]);
  });
});
