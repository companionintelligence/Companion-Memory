import type { Connection } from '../types';
import { SipeedClient } from '../clients/SipeedClient';

// Mock fetch globally
global.fetch = jest.fn();

describe('SipeedClient', () => {
  let client: SipeedClient;
  let mockConnection: Connection;

  beforeEach(() => {
    client = new SipeedClient();
    mockConnection = {
      id: 'test-connection-id',
      name: 'Test Sipeed Connection',
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
        name: 'Sipeed',
        apiBaseUrl: 'http://sipeed-camera.local:8080',
        tokenHost: null,
        tokenPath: null,
        authorizePath: null,
        scopes: null,
      },
    };

    jest.clearAllMocks();
  });

  describe('sync', () => {
    it('should successfully sync all Sipeed Camera APIs', async () => {
      const mockStatus = { status: 'online', firmware: '1.0.0' };
      const mockConfig = { resolution: '1080p', fps: 30 };
      const mockRecordings = [{ id: 'rec1', timestamp: '2024-01-01T00:00:00Z', duration: 120 }];
      const mockMotionEvents = [{ id: 'motion1', timestamp: '2024-01-01T01:00:00Z', confidence: 0.95 }];

      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockStatus),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockConfig),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockRecordings),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockMotionEvents),
        });

      const result = await client.sync(mockConnection);

      expect(result.success).toBe(true);
      expect(result.data!.results).toHaveLength(4);
      expect(result.data!.errors).toHaveLength(0);
      expect(result.message).toContain('4 APIs processed successfully');
      
      expect(fetch).toHaveBeenCalledWith(
        'http://sipeed-camera.local:8080/api/status',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-api-key',
          },
        })
      );
    });

    it('should handle partial API failures', async () => {
      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: 'online' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          statusText: 'Internal Server Error',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        })
        .mockRejectedValueOnce(new Error('Network error'));

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
  });
});