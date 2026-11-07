import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import { RETRIEVAL_POLICY_DEFAULTS } from '@ci/domains/retrieval-policy';
import { fileWeightedTexts, type FileSearchFields } from '@ci/domains/search-ingress/searchTexts';
import { buildVectorUpsertStatement } from '@ci/domains/search-ingress/services/VectorService';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { SearchService } from '../SearchService';

/**
 * Part of an uploaded file's name finds it, against a real Postgres.
 *
 * Postgres's text-search parser reads `os-plan-lighthouse.jpg` as one host
 * token, so before the file recipe indexed the spaced-out name too, only the
 * whole name matched and `lighthouse`, `receipt` or `jpg` came back empty. The
 * rows here are written by `buildVectorUpsertStatement`, the statement the
 * listener writes (the pipeline stage writes its batch form), from the real
 * `fileWeightedTexts`, and read back through `SearchService.search`, the call
 * the explorer makes.
 */

const SEARCH_NEXT_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(SEARCH_NEXT_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/SearchService.fileNames.integration] SKIPPED: ${availability.reason}`);
}

jest.setTimeout(60_000);

const FIXED_VECTOR = `[${Array(768).fill('0.1').join(',')}]`;

describeWithDatabase(`File name search against a live Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: SearchService;

  const userId = randomUUID();
  const context = { userId } as UserServiceContext;
  const photo = randomUUID();
  const receipt = randomUUID();

  const indexFile = async (entityId: string, file: FileSearchFields) => {
    const { sql, params } = buildVectorUpsertStatement(fileWeightedTexts(file), {
      id: randomUUID(),
      entityType: 'file',
      entityId,
      userId,
    });

    await dataSource.query(sql, params);
  };

  beforeAll(async () => {
    const connection = resolveConnection(SEARCH_NEXT_DATABASE_ENV);

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();

    service = new SearchService(
      dataSource,
      {
        generateEmbeddingString: jest.fn().mockResolvedValue(FIXED_VECTOR),
      } as unknown as EmbeddingGenerationService,
      { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as never,
      { send: jest.fn().mockResolvedValue([]) } as never,
    );

    await indexFile(photo, { filename: 'os-plan-lighthouse.jpg', contentType: 'image/jpeg' });
    await indexFile(receipt, { filename: 'os-plan-receipt.pdf', contentType: 'application/pdf' });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1::uuid', [userId]);
      await dataSource.destroy();
    }
  });

  const found = async (query: string) =>
    (await service.search(context, { query, mode: 'keyword', includeTypes: ['file'] }))
      .map((r) => r.id)
      .sort();

  it.each([
    ['lighthouse', [photo]],
    ['receipt', [receipt]],
    ['jpg', [photo]],
    ['os-plan-lighthouse', [photo]],
    ['os-plan-lighthouse.jpg', [photo]],
  ])('%p finds the right upload', async (query, expected) => {
    expect(await found(query)).toEqual([...expected].sort());
  });

  it('a word in both names finds both', async () => {
    expect(await found('plan')).toEqual([photo, receipt].sort());
  });

  it('the default search the explorer runs finds the photo by one word of its name', async () => {
    const results = await service.search(context, { query: 'lighthouse', includeTypes: ['file'] });

    expect(results.map((r) => r.id)).toContain(photo);
  });

  it('keeps the split words out of the device document', async () => {
    const documents = await dataSource.query(
      'SELECT title, body FROM ci_search.mobile_search_documents WHERE entity_type = $1 AND entity_id = $2',
      ['file', photo],
    );

    expect(documents).toEqual([{ title: 'os-plan-lighthouse.jpg', body: 'image/jpeg' }]);
  });
});
