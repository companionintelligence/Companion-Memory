import type { LoggerService } from '@ci/common/logging';
import { createMockConnection, createMockLogger } from '@ci/test/mocks';

import { listProviderCatalog } from '../catalog';
import { CatalogMockClient } from '../clients/CatalogMockClient';

const GOOGLE_PROVIDER_ID = '0198779b-182c-716e-9275-b81d99a47fdb';

describe('CatalogMockClient', () => {
  let client: CatalogMockClient;

  beforeEach(() => {
    client = new CatalogMockClient(createMockLogger() as unknown as LoggerService);
  });

  it('returns mock sync data for known catalog providers', async () => {
    const connection = createMockConnection(GOOGLE_PROVIDER_ID, {
      activeEndpoints: ['Gmail', 'Calendar'],
    });

    const responses = await client.sync(connection);

    expect(responses).toHaveLength(1);
    expect(responses[0]?.success).toBe(true);
    expect(responses[0]?.data?.results).toHaveLength(2);
    expect(responses[0]?.data?.results[0]?.api).toBe('Gmail');
    expect(responses[0]?.cursor).toBeDefined();
  });

  it('builds a local callback authorization url', async () => {
    const connection = createMockConnection(GOOGLE_PROVIDER_ID);

    const url = await client.getAuthorizationUrl(connection);

    expect(url).toContain('/oauth/callback');
    expect(url).toContain(`state=${connection.id}`);
    expect(url).toContain(`code=mock-${connection.providerId}`);
  });

  it('builds stable mock account identifiers', async () => {
    const connection = createMockConnection(GOOGLE_PROVIDER_ID, { userId: 'user-1' });

    const identifier = await client.getAccountIdentifier(connection);

    expect(identifier).toBe(`mock:${connection.providerId}:user-1`);
  });

  it('supports mock sync across every catalog provider', async () => {
    for (const provider of listProviderCatalog()) {
      const connection = createMockConnection(provider.providerId, {
        activeEndpoints: [],
      });

      const responses = await client.sync(connection);

      expect(responses).toHaveLength(1);
      expect(responses[0]?.success).toBe(true);
      expect((responses[0]?.data?.results?.length ?? 0) > 0).toBe(true);
    }
  });
});
