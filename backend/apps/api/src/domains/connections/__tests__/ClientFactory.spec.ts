/**
 * ClientFactory Tests
 */

import { ClientFactory } from '../clients/ClientFactory';
import { GoogleClient } from '../clients/GoogleClient';
import { MicrosoftClient } from '../clients/MicrosoftClient';
import { FacebookClient } from '../clients/FacebookClient';
import { createMockLogger } from '@ci/test/mocks';

// Mock the config module
jest.mock('@ci/configuration', () => ({
  default: {
    auth: {
      providers: {
        google: { id: 'google' },
        microsoft: { id: 'microsoft' },
        facebook: { id: 'facebook' },
      },
    },
  },
}));

describe('ClientFactory', () => {
  let factory: ClientFactory;
  let mockGoogleClient: jest.Mocked<GoogleClient>;
  let mockMicrosoftClient: jest.Mocked<MicrosoftClient>;
  let mockFacebookClient: jest.Mocked<FacebookClient>;

  beforeEach(() => {
    const mockLogger = createMockLogger();
    
    mockGoogleClient = {
      sync: jest.fn(),
      getAuthorizationUrl: jest.fn(),
    } as any;
    
    mockMicrosoftClient = {
      sync: jest.fn(),
      getAuthorizationUrl: jest.fn(),
    } as any;
    
    mockFacebookClient = {
      sync: jest.fn(),
      getAuthorizationUrl: jest.fn(),
    } as any;

    factory = new ClientFactory(
      mockGoogleClient,
      mockMicrosoftClient,
      mockFacebookClient,
    );
  });

  describe('getClientByProviderId', () => {
    it('should return GoogleClient for google provider', () => {
      const client = factory.getClientByProviderId('google');
      expect(client).toBe(mockGoogleClient);
    });

    it('should return MicrosoftClient for microsoft provider', () => {
      const client = factory.getClientByProviderId('microsoft');
      expect(client).toBe(mockMicrosoftClient);
    });

    it('should return FacebookClient for facebook provider', () => {
      const client = factory.getClientByProviderId('facebook');
      expect(client).toBe(mockFacebookClient);
    });

    it('should throw for null provider', () => {
      expect(() => factory.getClientByProviderId(null)).toThrow(
        'API client requested for a null Provider',
      );
    });

    it('should throw for undefined provider', () => {
      expect(() => factory.getClientByProviderId(undefined)).toThrow(
        'API client requested for a null Provider',
      );
    });

    it('should throw for unknown provider', () => {
      expect(() => factory.getClientByProviderId('unknown')).toThrow();
    });
  });
});
