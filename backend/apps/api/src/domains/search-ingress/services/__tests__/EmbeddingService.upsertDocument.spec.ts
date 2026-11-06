import type { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { searchDocumentHash } from '@ci/common/embeddings';

import type { EmbeddingEntity } from '../../entities/EmbeddingEntity';
import { EmbeddingService } from '../EmbeddingService';

/**
 * The unchanged-document gate: a row whose stored hash matches the document's
 * is neither sent to the model nor written; anything else is embedded and the
 * hash is written beside the vector.
 */
const ctx = { userId: 'user-1' } as UserServiceContext;

function makeService(storedHash: string | null | undefined) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const repo = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });

      if (sql.includes('SELECT source_hash')) {
        return storedHash === undefined ? [] : [{ source_hash: storedHash }];
      }

      return [
        {
          id: 'e-1',
          entity_type: 'note',
          entity_id: 'n-1',
          user_id: 'user-1',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];
    }),
  } as unknown as Repository<EmbeddingEntity>;
  const generate = jest.fn(async () => [0.1, 0.2]);

  return { service: new EmbeddingService(repo), queries, generate };
}

describe('EmbeddingService.upsertDocument', () => {
  const doc = 'Grocery list Milk, eggs, bread';

  it('neither embeds nor writes when the stored vector was made from this document', async () => {
    const { service, queries, generate } = makeService(searchDocumentHash(doc));

    await expect(
      service.upsertDocument(ctx, { entityType: 'note', entityId: 'n-1', text: doc }, generate),
    ).resolves.toBe('unchanged');

    expect(generate).not.toHaveBeenCalled();
    expect(queries.map((q) => q.sql.trim().split(/\s+/)[0])).toEqual(['SELECT']);
  });

  it('embeds and writes, hash beside the vector, when the document changed', async () => {
    const { service, queries, generate } = makeService(searchDocumentHash('an older wording'));

    await expect(
      service.upsertDocument(ctx, { entityType: 'note', entityId: 'n-1', text: doc }, generate),
    ).resolves.toBe('embedded');

    expect(generate).toHaveBeenCalledWith(doc);
    const insert = queries.find((q) => q.sql.includes('INSERT INTO ci_search.embeddings'))!;
    expect(insert.params[5]).toBe(searchDocumentHash(doc));
    expect(insert.params[3]).toBe('[0.1,0.2]');
  });

  it('embeds a row that has no vector yet, and one written before the hash was kept', async () => {
    for (const stored of [undefined, null] as const) {
      const { service, generate } = makeService(stored);

      await expect(
        service.upsertDocument(ctx, { entityType: 'note', entityId: 'n-1', text: doc }, generate),
      ).resolves.toBe('embedded');
      expect(generate).toHaveBeenCalledTimes(1);
    }
  });

  it('reads a change of embed model as a change of document', () => {
    expect(searchDocumentHash(doc, 'nomic-embed-text')).not.toBe(searchDocumentHash(doc, 'some-other-model'));
    // The same weights under another engine's spelling make the same vectors: the same hash.
    expect(searchDocumentHash(doc, 'nomic-embed-text:latest')).toBe(
      searchDocumentHash(doc, 'nomic-embed-text'),
    );
  });
});
