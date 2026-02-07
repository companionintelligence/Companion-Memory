/**
 * GoogleClient Tests
 */

import { GoogleClient } from '../clients/GoogleClient';
import { LoggerService } from '@ci/common/logging';
import {
  createMockConnection,
  createMockLogger,
  mockFetchResponse,
  mockFetchError,
  googleMocks,
} from '@ci/test/mocks';

// Mock the config module
jest.mock('@ci/configuration', () => ({
  default: {
    auth: {
      providers: {
        google: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
        },
      },
    },
    app: {
      baseUrl: 'http://localhost:3000',
    },
  },
}));

describe('GoogleClient', () => {
  let client: GoogleClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new GoogleClient(mockLogger as unknown as LoggerService);
  });

  describe('getAuthorizationUrl', () => {
    it('should generate valid OAuth URL', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['Calendar', 'Gmail'],
      });

      const url = await client.getAuthorizationUrl(connection);

      expect(url).toContain('accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('response_type=code');
      expect(url).toContain('access_type=offline');
    });

    it('should include correct scopes for Calendar endpoint', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['Calendar'],
      });

      const url = await client.getAuthorizationUrl(connection);

      expect(url).toContain('calendar.readonly');
    });

    it('should include correct scopes for Gmail endpoint', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['Gmail'],
      });

      const url = await client.getAuthorizationUrl(connection);

      expect(url).toContain('gmail.readonly');
    });
  });

  describe('sync', () => {
    it('should sync calendar events', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['Calendar'],
        syncState: {},
      });

      // Mock calendar list response
      mockFetchResponse(googleMocks.calendarList);
      // Mock calendar events response
      mockFetchResponse(googleMocks.calendarEvents);

      const responses = await client.sync(connection);

      expect(responses.length).toBeGreaterThan(0);
      expect(responses[0].success).toBe(true);
    });

    it('should sync Gmail messages', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['Gmail'],
        syncState: {},
      });

      // Mock messages list response
      mockFetchResponse(googleMocks.gmailMessages);
      // Mock individual message responses
      mockFetchResponse(googleMocks.gmailMessage('msg-1'));
      mockFetchResponse(googleMocks.gmailMessage('msg-2'));

      const responses = await client.sync(connection);

      expect(responses.length).toBeGreaterThan(0);
    });

    it('should handle API errors gracefully', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['Calendar'],
      });

      mockFetchError('API rate limited');

      const responses = await client.sync(connection);

      // Should return error response, not throw
      expect(responses[0].success).toBe(false);
    });

    it('should handle expired tokens', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['Calendar'],
        tokenExpiry: new Date(Date.now() - 3600000), // Expired 1 hour ago
      });

      mockFetchResponse({ error: 'invalid_token' }, { status: 401, ok: false });

      const responses = await client.sync(connection);

      expect(responses[0].success).toBe(false);
    });
  });

  describe('refreshAccessToken', () => {
    it('should refresh the access token', async () => {
      const connection = createMockConnection('google');

      mockFetchResponse({
        access_token: 'new-access-token',
        expires_in: 3600,
      });

      const result = await client.refreshAccessToken(connection);

      expect(result.accessToken).toBe('new-access-token');
      expect(result.tokenExpiry).toBeDefined();
    });

    it('should handle refresh failures', async () => {
      const connection = createMockConnection('google');

      mockFetchResponse({ error: 'invalid_grant' }, { status: 400, ok: false });

      await expect(client.refreshAccessToken(connection)).rejects.toThrow();
    });
  });

  describe('getAccountIdentifier', () => {
    it('should return the user email', async () => {
      const connection = createMockConnection('google');

      mockFetchResponse({
        email: 'user@gmail.com',
        verified_email: true,
      });

      const identifier = await client.getAccountIdentifier(connection);

      expect(identifier).toBe('user@gmail.com');
    });
  });
});
