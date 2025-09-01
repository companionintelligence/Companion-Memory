import type { Connection } from '../types';
import { IOSClient } from '../clients/IOSClient';

describe('IOSClient', () => {
  let client: IOSClient;
  let mockConnection: Connection;

  beforeEach(() => {
    client = new IOSClient();
    mockConnection = {
      id: 'test-connection-id',
      name: 'Test iOS Connection',
      active: true,
      clientid: null,
      clientkey: null,
      clientsecret: null,
      schedule: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      provider: {
        id: 'provider-id',
        name: 'iOS',
        apiBaseUrl: null,
        tokenHost: null,
        tokenPath: null,
        authorizePath: null,
        scopes: null,
      },
    };
  });

  describe('getConnectionInstructions', () => {
    it('should return iOS connection instructions', () => {
      const instructions = client.getConnectionInstructions();
      
      expect(instructions).toContain('Install the Companion Intelligence iOS app from the App Store');
      expect(instructions).toContain('Settings > Connect to Server');
      expect(instructions).toContain('Enter your server details and authenticate');
      expect(instructions).toContain('Grant necessary permissions for data access');
    });
  });

  describe('sync', () => {
    it('should return success response for iOS platform connection', async () => {
      const result = await client.sync(mockConnection);

      expect(result.success).toBe(true);
      expect(result.message).toContain('iOS device connection established');
      expect(result.data!.results).toHaveLength(1);
      expect(result.data!.results[0].api).toBe('iOS Device');
      expect((result.data!.results[0].data as any).platform).toBe('iOS');
      expect((result.data!.results[0].data as any).status).toBe('connected');
      expect(result.data!.errors).toHaveLength(0);
    });
  });

  describe('OAuth and API methods', () => {
    it('should throw error for getAuthorizationUrl', async () => {
      await expect(client.getAuthorizationUrl(mockConnection)).rejects.toThrow(
        'Platform connections do not support web-based OAuth authorization'
      );
    });

    it('should throw error for exchangeAuthorizationCode', async () => {
      await expect(client.exchangeAuthorizationCode(mockConnection, 'code')).rejects.toThrow(
        'Platform connections do not support OAuth token exchange'
      );
    });

    it('should throw error for request', async () => {
      await expect(client.request(mockConnection, '/api/test')).rejects.toThrow(
        'Platform connections do not support direct HTTP requests'
      );
    });
  });
});