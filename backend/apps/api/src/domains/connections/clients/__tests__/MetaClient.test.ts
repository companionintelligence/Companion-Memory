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
      const mockFacebookEvents = { data: [{ id: '101', name: 'Test Event' }] };
      const mockFacebookLikes = { data: [{ id: '102', name: 'Test Page' }] };
      const mockFacebookAlbums = { data: [{ id: '103', name: 'Test Album' }] };
      const mockFacebookVideos = { data: [{ id: '104', title: 'Test Video' }] };
      const mockFacebookPosts = { data: [{ id: '105', message: 'Test Post', comments: { data: [] } }] };
      const mockFacebookPages = { data: [{ id: '106', name: 'Test Page' }] };
      const mockFacebookMessages = { data: [{ id: '107', updated_time: new Date().toISOString() }] };
      const mockInstagramProfile = { data: { id: '123', username: 'testuser' } };
      const mockInstagramMedia = { data: [{ id: '456', type: 'image' }] };
      const mockInstagramMediaWithComments = { data: [{ id: '456', type: 'image' }] };
      const mockInstagramComments = { data: [{ id: '457', text: 'Test comment' }] };
      const mockInstagramLiked = { data: [{ id: '458', type: 'image' }] };

      (metaClient as any).request = jest.fn()
        .mockResolvedValueOnce(mockFacebookProfile)
        .mockResolvedValueOnce(mockFacebookFeed)
        .mockResolvedValueOnce(mockFacebookPhotos)
        .mockResolvedValueOnce(mockFacebookEvents)
        .mockResolvedValueOnce(mockFacebookLikes)
        .mockResolvedValueOnce(mockFacebookAlbums)
        .mockResolvedValueOnce(mockFacebookVideos)
        .mockResolvedValueOnce(mockFacebookPosts)
        .mockResolvedValueOnce(mockFacebookPages)
        .mockResolvedValueOnce(mockFacebookMessages)
        .mockResolvedValueOnce(mockInstagramProfile)
        .mockResolvedValueOnce(mockInstagramMedia)
        .mockResolvedValueOnce(mockInstagramMediaWithComments)
        .mockResolvedValueOnce(mockInstagramComments)
        .mockResolvedValueOnce(mockInstagramLiked);

      const result = await metaClient.sync(mockConnection);

      expect(result.success).toBe(true);
      expect(result.data?.results).toHaveLength(14); // Updated count for new endpoints
      expect(result.data?.errors).toHaveLength(0);
      expect(result.message).toContain('14 APIs processed successfully');
    });

    it('should handle API failures gracefully', async () => {
      // Mock API failure
      (metaClient as any).request = jest.fn()
        .mockRejectedValue(new Error('API Error'));

      const result = await metaClient.sync(mockConnection);

      expect(result.success).toBe(false);
      expect(result.data?.results).toHaveLength(0);
      expect(result.data?.errors).toHaveLength(14); // Updated count for new endpoints
      expect(result.data?.errors?.[0]).toContain('Facebook Profile API failed');
    });

    it('should handle partial failures', async () => {
      // Mock mixed success/failure responses
      const mockFacebookProfile = { id: '123', name: 'Test User' };
      
      (metaClient as any).request = jest.fn()
        .mockResolvedValueOnce(mockFacebookProfile)
        .mockRejectedValueOnce(new Error('Feed API Error'))
        .mockRejectedValueOnce(new Error('Photos API Error'))
        .mockRejectedValueOnce(new Error('Events API Error'))
        .mockRejectedValueOnce(new Error('Likes API Error'))
        .mockRejectedValueOnce(new Error('Albums API Error'))
        .mockRejectedValueOnce(new Error('Videos API Error'))
        .mockRejectedValueOnce(new Error('Posts API Error'))
        .mockRejectedValueOnce(new Error('Pages API Error'))
        .mockRejectedValueOnce(new Error('Messages API Error'))
        .mockRejectedValueOnce(new Error('Instagram Profile API Error'))
        .mockRejectedValueOnce(new Error('Instagram Media API Error'))
        .mockRejectedValueOnce(new Error('Instagram Media Comments API Error'))
        .mockRejectedValueOnce(new Error('Instagram Liked API Error'));

      const result = await metaClient.sync(mockConnection);

      expect(result.success).toBe(false);
      expect(result.data?.results).toHaveLength(1);
      expect(result.data?.errors).toHaveLength(13); // Updated count (14 total - 1 success = 13 errors)
      expect(result.message).toContain('1 APIs processed successfully');
      expect(result.message).toContain('13 errors occurred');
    });

    it('should make correct API calls', async () => {
      const mockRequest = jest.fn().mockResolvedValue({ data: [] });
      (metaClient as any).request = mockRequest;

      await metaClient.sync(mockConnection);

      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me?fields=id,name,email');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/feed?limit=10&fields=id,message,created_time,type');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/photos?limit=10&fields=id,name,picture,created_time');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/events?limit=10&fields=id,name,start_time,end_time,place,description');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/likes?limit=10&fields=id,name,category,created_time');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/albums?limit=10&fields=id,name,description,created_time,count');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/videos?limit=10&fields=id,title,description,created_time,source');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/posts?limit=10&fields=id,message,created_time,comments{id,message,created_time,from}');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/accounts?limit=10&fields=id,name,category,access_token');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/me/conversations?limit=10&fields=id,updated_time,message_count');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/v1/users/self');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/v1/users/self/media/recent?count=10');
      expect(mockRequest).toHaveBeenCalledWith(mockConnection, '/v1/users/self/media/liked?count=10');
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