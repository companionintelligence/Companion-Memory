import type { Connection } from '../types';
import { HomeAssistantClient } from '../clients/HomeAssistantClient';

// Mock fetch globally
global.fetch = jest.fn();

describe('HomeAssistantClient', () => {
  let client: HomeAssistantClient;
  let mockConnection: Connection;

  beforeEach(() => {
    client = new HomeAssistantClient();
    mockConnection = {
      id: 'test-connection-id',
      name: 'Test Home Assistant Connection',
      active: true,
      clientid: null,
      clientkey: 'test-api-key',
      clientsecret: null,
      schedule: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      provider: {
        id: 'provider-id',
        name: 'HomeAssistant',
        apiBaseUrl: 'http://homeassistant.local:8123',
        tokenHost: null,
        tokenPath: null,
        authorizePath: null,
        scopes: null,
      },
    };

    jest.clearAllMocks();
  });

  describe('sync', () => {
    it('should successfully sync all Home Assistant APIs', async () => {
      const mockSystemInfo = { version: '2024.1.0', location_name: 'Home' };
      const mockStates = [{ entity_id: 'light.living_room', state: 'on' }];
      const mockServices = { light: { turn_on: {}, turn_off: {} } };
      const mockHistory = [{ entity_id: 'light.living_room', state: 'on', last_changed: '2024-01-01T00:00:00Z' }];

      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockSystemInfo),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockStates),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockServices),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockHistory),
        });

      const result = await client.sync(mockConnection);

      expect(result.success).toBe(true);
      expect(result.data!.results).toHaveLength(4);
      expect(result.data!.errors).toHaveLength(0);
      expect(result.message).toContain('4 APIs processed successfully');
    });

    it('should handle API failures gracefully', async () => {
      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: false,
          statusText: 'Unauthorized',
        })
        .mockResolvedValueOnce({
          ok: false,
          statusText: 'Not Found',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ light: {} }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        });

      const result = await client.sync(mockConnection);

      expect(result.success).toBe(false);
      expect(result.data!.results).toHaveLength(2);
      expect(result.data!.errors).toHaveLength(2);
      expect(result.message).toContain('2 errors occurred');
    });

    it('should handle missing API key gracefully', async () => {
      const connectionWithoutKey = { ...mockConnection, clientkey: null };

      const result = await client.sync(connectionWithoutKey);
      
      expect(result.success).toBe(false);
      expect(result.data!.errors).toHaveLength(4);
      expect(result.data!.errors[0]).toContain('API key not configured for connection');
    });

    it('should handle missing provider gracefully', async () => {
      const connectionWithoutProvider = { ...mockConnection, provider: undefined };

      const result = await client.sync(connectionWithoutProvider);
      
      expect(result.success).toBe(false);
      expect(result.data!.errors).toHaveLength(4);
      expect(result.data!.errors[0]).toContain('Connection not associated with a provider');
    });

    it('should handle missing API base URL gracefully', async () => {
      const connectionWithoutApiUrl = { 
        ...mockConnection, 
        provider: { ...mockConnection.provider!, apiBaseUrl: null }
      };

      const result = await client.sync(connectionWithoutApiUrl);
      
      expect(result.success).toBe(false);
      expect(result.data!.errors).toHaveLength(4);
      expect(result.data!.errors[0]).toContain('Provider missing base URL configuration');
    });
  });
});