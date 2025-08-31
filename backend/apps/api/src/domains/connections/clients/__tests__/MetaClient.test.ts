import { MetaClient } from '../MetaClient';
import type { Connection } from '../../types';

// Mock the BaseOAuth2Client
jest.mock('../BaseOAuth2Client', () => ({
  BaseOAuth2Client: class {
    logger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };
    
    request = jest.fn();
  },
}));

describe('MetaClient', () => {
  let metaClient: MetaClient;
  let mockConnection: Connection;

  beforeEach(() => {
    metaClient = new MetaClient();
    mockConnection = {
      id: 'test-connection-id',
      name: 'Test Meta Connection',
      active: true,
      clientid: 'test-client-id',
      clientkey: 'test-client-key',
      clientsecret: 'test-client-secret',
      schedule: null,
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      tokenExpiry: new Date(),
      provider: {
        id: 'test-provider-id',
        name: 'Meta',
        tokenHost: 'https://graph.facebook.com',
        tokenPath: '/oauth/access_token',
        authorizePath: 'https://www.facebook.com/dialog/oauth',
        apiBaseUrl: 'https://graph.facebook.com',
        scopes: 'user_posts user_photos instagram_basic',
      },
    } as Connection;
  });

  describe('sync', () => {
    it('should successfully sync all Meta APIs', async () => {
      // Mock successful API responses
      const mockFacebookProfile = { id: '123', name: 'Test User', email: 'test@example.com' };
      const mockFacebookFeed = { data: [{ id: '456', message: 'Test post' }] };
      const mockFacebookPhotos = { data: [{ id: '789', name: 'Test photo' }] };
      const mockInstagramProfile = { data: { id: '123', username: 'testuser' } };
      const mockInstagramMedia = { data: [{ id: '456', type: 'image' }] };

      (metaClient as any).request = jest.fn()
        .mockResolvedValueOnce(mockFacebookProfile)
        .mockResolvedValueOnce(mockFacebookFeed)
        .mockResolvedValueOnce(mockFacebookPhotos)
        .mockResolvedValueOnce(mockInstagramProfile)
        .mockResolvedValueOnce(mockInstagramMedia);

      const result = await metaClient.sync(mockConnection);

      expect(result.success).toBe(true);
      expect(result.data?.results).toHaveLength(5);
      expect(result.data?.errors).toHaveLength(0);
      expect(result.message).toContain('5 APIs processed successfully');
    });

    it('should handle API failures gracefully', async () => {
      // Mock API failure
      (metaClient as any).request = jest.fn()
        .mockRejectedValue(new Error('API Error'));

      const result = await metaClient.sync(mockConnection);

      expect(result.success).toBe(false);
      expect(result.data?.results).toHaveLength(0);
      expect(result.data?.errors).toHaveLength(5);
      expect(result.data?.errors?.[0]).toContain('Facebook Profile API failed');
    });

    it('should handle partial failures', async () => {
      // Mock mixed success/failure responses
      const mockFacebookProfile = { id: '123', name: 'Test User' };
      
      (metaClient as any).request = jest.fn()
        .mockResolvedValueOnce(mockFacebookProfile)
        .mockRejectedValueOnce(new Error('Feed API Error'))
        .mockRejectedValueOnce(new Error('Photos API Error'))
        .mockRejectedValueOnce(new Error('Instagram Profile API Error'))
        .mockRejectedValueOnce(new Error('Instagram Media API Error'));

      const result = await metaClient.sync(mockConnection);

      expect(result.success).toBe(false);
      expect(result.data.results).toHaveLength(1);
      expect(result.data.errors).toHaveLength(4);
      expect(result.message).toContain('1 APIs processed successfully');
      expect(result.message).toContain('4 errors occurred');
    });

    it('should make correct API calls', async () => {
      const mockRequest = jest.fn().mockResolvedValue({ data: [] });
      (metaClient as any).request = mockRequest;

      await metaClient.sync(mockConnection);

      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me?fields=id,name,email');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/feed?limit=10&fields=id,message,created_time,type');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/photos?limit=10&fields=id,name,picture,created_time');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/v1/users/self');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/v1/users/self/media/recent?count=10');
    });

    it('should log sync activity', async () => {
      const mockRequest = jest.fn().mockResolvedValue({ data: [] });
      (metaClient as any).request = mockRequest;
      const logSpy = jest.spyOn((metaClient as any).logger, 'log');

      await metaClient.sync(mockConnection);

      expect(logSpy).toHaveBeenCalledWith('Syncing Meta data', { connectionId: mockConnection.id });
    });
  });
});