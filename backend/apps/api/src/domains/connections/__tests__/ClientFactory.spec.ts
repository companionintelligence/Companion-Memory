/**
 * ClientFactory Tests
 */

import type { CatalogMockClient } from '../clients/CatalogMockClient';
import type { FacebookClient } from '../clients/FacebookClient';
import type { GoogleClient } from '../clients/GoogleClient';
import type { MicrosoftClient } from '../clients/MicrosoftClient';

jest.mock('@ci/configuration', () => ({
  default: {
    auth: {
      providers: {
        google: { id: 'google' },
        microsoft: { id: 'microsoft' },
        facebook: { id: 'facebook' },
      },
      oauth: {
        callbackUrl: 'http://localhost:3000/oauth/callback',
      },
    },
    logging: {
      level: 'debug',
    },
  },
}));

jest.mock('@ci/common/logging', () => ({
  LoggerService: class LoggerService {},
}));

jest.mock('@ci/domains/connections/catalog', () => ({
  getProviderCatalogByProviderId: jest.fn(),
}));

describe('ClientFactory', () => {
  let factory: import('../clients/ClientFactory').ClientFactory;
  let ClientFactoryCtor: typeof import('../clients/ClientFactory').ClientFactory;
  let getProviderCatalogByProviderIdMock: jest.Mock;

  let mockGoogleClient: GoogleClient;
  let mockMicrosoftClient: MicrosoftClient;
  let mockFacebookClient: FacebookClient;
  let mockCatalogMockClient: CatalogMockClient;

  beforeAll(async () => {
    const clientFactoryModule = await import('../clients/ClientFactory');
    ClientFactoryCtor = clientFactoryModule.ClientFactory;

    const catalogModule = await import('@ci/domains/connections/catalog');
    getProviderCatalogByProviderIdMock = catalogModule.getProviderCatalogByProviderId as jest.Mock;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PROVIDER_DISCORD_MODE;

    mockGoogleClient = { getAuthorizationUrl: jest.fn(), sync: jest.fn() } as unknown as GoogleClient;
    mockMicrosoftClient = { getAuthorizationUrl: jest.fn(), sync: jest.fn() } as unknown as MicrosoftClient;
    mockFacebookClient = { getAuthorizationUrl: jest.fn(), sync: jest.fn() } as unknown as FacebookClient;
    mockCatalogMockClient = {
      getAuthorizationUrl: jest.fn(),
      sync: jest.fn(),
    } as unknown as CatalogMockClient;

    factory = new ClientFactoryCtor(
      mockGoogleClient,
      mockMicrosoftClient,
      mockFacebookClient,
      mockCatalogMockClient,
    );
  });

  describe('getClientByProviderId', () => {
    it('returns built-in clients for implemented providers', () => {
      expect(factory.getClientByProviderId('google')).toBe(mockGoogleClient);
      expect(factory.getClientByProviderId('microsoft')).toBe(mockMicrosoftClient);
      expect(factory.getClientByProviderId('facebook')).toBe(mockFacebookClient);
    });

    it('throws for nullish provider id', () => {
      expect(() => factory.getClientByProviderId(null)).toThrow('API client requested for a null Provider');
      expect(() => factory.getClientByProviderId(undefined)).toThrow(
        'API client requested for a null Provider',
      );
    });

    it('throws for unknown provider without mock mode', () => {
      getProviderCatalogByProviderIdMock.mockReturnValue(undefined);

      expect(() => factory.getClientByProviderId('unknown')).toThrow('Unsupported Provider id: unknown');
    });

    it('returns catalog mock client when provider mode is mock', () => {
      getProviderCatalogByProviderIdMock.mockReturnValue({
        key: 'discord',
        auth: { env: { modeVar: 'PROVIDER_DISCORD_MODE' } },
      });
      process.env.PROVIDER_DISCORD_MODE = 'mock';

      expect(factory.getClientByProviderId('discord-provider-id')).toBe(mockCatalogMockClient);
    });
  });

  describe('helper methods', () => {
    it('getClientByProviderIdOrNull returns null for unknown provider', () => {
      getProviderCatalogByProviderIdMock.mockReturnValue(undefined);

      expect(factory.getClientByProviderIdOrNull('unknown')).toBeNull();
    });

    it('hasClientForProviderId reflects mock-mode activation', () => {
      getProviderCatalogByProviderIdMock.mockReturnValue({
        key: 'discord',
        auth: { env: { modeVar: 'PROVIDER_DISCORD_MODE' } },
      });

      expect(factory.hasClientForProviderId('discord-provider-id')).toBe(false);

      process.env.PROVIDER_DISCORD_MODE = 'mock';

      expect(factory.hasClientForProviderId('discord-provider-id')).toBe(true);
    });
  });
});
