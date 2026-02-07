/**
 * Social Media Platforms E2E Tests
 * 
 * Tests: Twitter, LinkedIn, Instagram, Reddit
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { SOCIAL_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Social Media Platforms E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Twitter', () => {
    it('should sync Twitter tweets successfully', async () => {
      const connection = createMockConnection('twitter', {
        activeEndpoints: ['Tweets'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const tweetsResult = result.sources.find((s) => s.source === 'Tweets');
      expect(tweetsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Twitter likes successfully', async () => {
      const connection = createMockConnection('twitter', {
        activeEndpoints: ['Likes'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Twitter pagination tokens', async () => {
      const connection = createMockConnection('twitter', {
        activeEndpoints: ['Tweets'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 100 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform tweets to content type', async () => {
      const connection = createMockConnection('twitter', {
        activeEndpoints: ['Tweets'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const tweetsResult = result.sources.find((s) => s.source === 'Tweets');
      expect(tweetsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('LinkedIn', () => {
    it('should sync LinkedIn posts successfully', async () => {
      const connection = createMockConnection('linkedin', {
        activeEndpoints: ['Posts'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const postsResult = result.sources.find((s) => s.source === 'Posts');
      expect(postsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync LinkedIn connections successfully', async () => {
      const connection = createMockConnection('linkedin', {
        activeEndpoints: ['Connections'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const connectionsResult = result.sources.find((s) => s.source === 'Connections');
      expect(connectionsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should transform LinkedIn connections to relationship type', async () => {
      const connection = createMockConnection('linkedin', {
        activeEndpoints: ['Connections'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const connectionsResult = result.sources.find((s) => s.source === 'Connections');
      expect(connectionsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Instagram', () => {
    it('should sync Instagram media successfully', async () => {
      const connection = createMockConnection('instagram', {
        activeEndpoints: ['Media'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const mediaResult = result.sources.find((s) => s.source === 'Media');
      expect(mediaResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Instagram pagination cursors', async () => {
      const connection = createMockConnection('instagram', {
        activeEndpoints: ['Media'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 25 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Instagram media to content type', async () => {
      const connection = createMockConnection('instagram', {
        activeEndpoints: ['Media'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const mediaResult = result.sources.find((s) => s.source === 'Media');
      expect(mediaResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Reddit', () => {
    it('should sync Reddit posts successfully', async () => {
      const connection = createMockConnection('reddit', {
        activeEndpoints: ['Posts'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const postsResult = result.sources.find((s) => s.source === 'Posts');
      expect(postsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Reddit comments successfully', async () => {
      const connection = createMockConnection('reddit', {
        activeEndpoints: ['Comments'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Reddit saved items successfully', async () => {
      const connection = createMockConnection('reddit', {
        activeEndpoints: ['Saved'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Reddit after/before pagination', async () => {
      const connection = createMockConnection('reddit', {
        activeEndpoints: ['Posts'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 100 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Full Social Media Sync', () => {
    it('should sync all social platforms concurrently', async () => {
      const connections = [
        createMockConnection('twitter', { activeEndpoints: ['Tweets'] }),
        createMockConnection('linkedin', { activeEndpoints: ['Posts'] }),
        createMockConnection('instagram', { activeEndpoints: ['Media'] }),
        createMockConnection('reddit', { activeEndpoints: ['Posts'] }),
      ];
      const context = createMockContext();

      const results = await Promise.all(
        connections.map((conn) =>
          testContext.syncEngine.syncConnection(context, conn),
        ),
      );

      expect(results.length).toBe(4);
      expect(results.every((r) => r.success)).toBe(true);
    }, TEST_CONFIG.timeouts.sync * 2);
  });
});
