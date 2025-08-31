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
  });
});
