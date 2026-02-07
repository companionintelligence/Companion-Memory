import { listProviderCatalog } from '../catalog';
import type { CatalogMockClient } from '../clients/CatalogMockClient';
import { ClientFactory } from '../clients/ClientFactory';
import type { FacebookClient } from '../clients/FacebookClient';
import type { GoogleClient } from '../clients/GoogleClient';
import type { MicrosoftClient } from '../clients/MicrosoftClient';

describe('ClientFactory catalog coverage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves all catalog providers when mode vars are set to mock', () => {
    const providers = listProviderCatalog();

    for (const provider of providers) {
      process.env[provider.auth.env.modeVar] = 'mock';
    }

    const factory = new ClientFactory(
      { getAuthorizationUrl: jest.fn(), sync: jest.fn() } as unknown as GoogleClient,
      { getAuthorizationUrl: jest.fn(), sync: jest.fn() } as unknown as MicrosoftClient,
      { getAuthorizationUrl: jest.fn(), sync: jest.fn() } as unknown as FacebookClient,
      { getAuthorizationUrl: jest.fn(), sync: jest.fn() } as unknown as CatalogMockClient,
    );

    for (const provider of providers) {
      expect(factory.hasClientForProviderId(provider.providerId)).toBe(true);
      expect(factory.getClientByProviderIdOrNull(provider.providerId)).not.toBeNull();
    }
  });
});
