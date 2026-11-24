import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { searchDocumentHash } from '@ci/common/embeddings';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { EmbeddingEntity } from '../../entities/EmbeddingEntity';
import { EmbeddingService } from '../EmbeddingService';

/**
 * The unchanged-document gate against a live Postgres: the second call with
 * the same document makes no model call and leaves the row alone; a changed
 * document is embedded again and the hash follows it.
 */
const ENV = { urlEnvVar: 'SEARCH_INGRESS_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[EmbeddingService.sourceHash.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`EmbeddingService.upsertDocument keeps an unchanged document (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: EmbeddingService;
  const userId = randomUUID();
  const entityId = randomUUID();
  const ctx = { userId } as UserServiceContext;
  const vector = Array.from({ length: 768 }, (_, i) => (i % 7) / 10);
  const generate = jest.fn(async () => vector);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [EmbeddingEntity],
    });
    await dataSource.initialize();
    service = new EmbeddingService(dataSource.getRepository(EmbeddingEntity));
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = $1', [userId]);
      await dataSource.destroy();
    }
  });

  const stored = async () =>
    (
      await dataSource.query<Array<{ source_hash: string | null; updated_at: Date }>>(
        'SELECT source_hash, updated_at FROM ci_search.embeddings WHERE entity_type = $1 AND entity_id = $2',
        ['note', entityId],
      )
    )[0];

  it('embeds once, keeps the row on an unchanged document, and re-embeds a changed one', async () => {
    const doc = 'Grocery list Milk, eggs, bread';

    await expect(
      service.upsertDocument(ctx, { entityType: 'note', entityId, text: doc }, generate),
    ).resolves.toBe('embedded');
    expect(generate).toHaveBeenCalledTimes(1);
    const first = await stored();
    expect(first.source_hash).toBe(searchDocumentHash(doc));

    await expect(
      service.upsertDocument(ctx, { entityType: 'note', entityId, text: doc }, generate),
    ).resolves.toBe('unchanged');
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await stored()).updated_at).toEqual(first.updated_at);

    await expect(
      service.upsertDocument(ctx, { entityType: 'note', entityId, text: `${doc} and butter` }, generate),
    ).resolves.toBe('embedded');
    expect(generate).toHaveBeenCalledTimes(2);
    expect((await stored()).source_hash).toBe(searchDocumentHash(`${doc} and butter`));
  });

  it('embeds a row written before the hash was kept, exactly once', async () => {
    await dataSource.query('UPDATE ci_search.embeddings SET source_hash = NULL WHERE entity_id = $1', [
      entityId,
    ]);
    generate.mockClear();

    await expect(
      service.upsertDocument(ctx, { entityType: 'note', entityId, text: 'x y z' }, generate),
    ).resolves.toBe('embedded');
    await expect(
      service.upsertDocument(ctx, { entityType: 'note', entityId, text: 'x y z' }, generate),
    ).resolves.toBe('unchanged');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
