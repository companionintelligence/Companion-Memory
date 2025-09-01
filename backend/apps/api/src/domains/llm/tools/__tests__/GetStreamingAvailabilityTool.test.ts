import config from '@ci/configuration';

import { GetStreamingAvailabilityTool } from '../GetStreamingAvailabilityTool';

describe('GetStreamingAvailabilityTool', () => {
  let tool: GetStreamingAvailabilityTool;

  beforeEach(() => {
    tool = new GetStreamingAvailabilityTool();
  });

  describe('Configuration', () => {
    it('should have TMDB configuration available', () => {
      expect(config.dataProviders).toBeDefined();
      expect(config.dataProviders.tmdb).toBeDefined();
      expect(config.dataProviders.tmdb.apiKey).toBeDefined();
    });

    it('should handle missing TMDB API key gracefully', async () => {
      // Mock the config to return demo-key
      const originalApiKey = config.dataProviders.tmdb.apiKey;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config.dataProviders.tmdb as any).apiKey = 'demo-key';

      const mockContext = {
        userId: 'test-user-id',
        requestId: 'test-request-id',
      };

      const input = {
        genre: 'action',
        contentType: 'movie' as const,
        country: 'US',
        limit: 5,
      };

      const result = await tool.execute(mockContext, input);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('TMDB_API_KEY not configured in application settings');

      // Restore original value
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config.dataProviders.tmdb as any).apiKey = originalApiKey;
    });

    it('should have correct schema definition', () => {
      expect(tool.schema.name).toBe('get_streaming_availability');
      expect(tool.schema.category).toBe('external_api');
      expect(tool.schema.description).toContain('streaming availability');
    });

    it('should use config-based API key access instead of direct environment variables', () => {
      // Verify that the tool accesses TMDB API key through config
      expect(config.dataProviders.tmdb.apiKey).toBeDefined();
      
      // This test ensures that the migration from process.env.TMDB_API_KEY to config is complete
      // The actual usage is verified by checking that all methods in the tool use config.dataProviders.tmdb.apiKey
      const toolSource = tool.constructor.toString();
      expect(toolSource).not.toContain('process.env.TMDB_API_KEY');
    });

    it('should work with valid API key configuration', async () => {
      // Mock a valid API key
      const originalApiKey = config.dataProviders.tmdb.apiKey;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config.dataProviders.tmdb as any).apiKey = 'valid-test-key';

      // Mock fetch to avoid actual API calls
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      // Mock the trending response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          results: [
            {
              id: 12345,
              title: 'Test Movie',
              media_type: 'movie',
              genre_ids: [28], // Action genre
              overview: 'A test movie',
              vote_average: 7.5,
              release_date: '2024-01-01',
              poster_path: '/test-poster.jpg'
            }
          ]
        })
      });

      // Mock the watch providers response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          results: {
            US: {
              flatrate: [
                { provider_name: 'Netflix' }
              ]
            }
          }
        })
      });

      // Mock the genre list response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          genres: [
            { id: 28, name: 'Action' }
          ]
        })
      });

      const mockContext = {
        userId: 'test-user-id',
        requestId: 'test-request-id',
      };

      const input = {
        contentType: 'movie' as const,
        country: 'US',
        limit: 5,
      };

      const result = await tool.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.data?.titles).toBeDefined();
      expect(result.data?.metadata.source).toBe('TMDB');

      // Restore original values
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config.dataProviders.tmdb as any).apiKey = originalApiKey;
      // @ts-ignore - Reset fetch
      delete global.fetch;
    });
  });
});
