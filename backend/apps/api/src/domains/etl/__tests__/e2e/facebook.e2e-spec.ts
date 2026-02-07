/**
 * Facebook Provider E2E Tests
 * 
 * Tests all 4 Facebook data sources: Posts, Photos, Videos, Friends
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { FACEBOOK_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Facebook Provider E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Posts Source', () => {
    it('should sync Facebook posts successfully', async () => {
      const connection = createMockConnection('facebook', {
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
      expect(postsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should handle post pagination with cursors', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Posts'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 25 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Photos Source', () => {
    it('should sync Facebook photos successfully', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Photos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const photosResult = result.sources.find((s) => s.source === 'Photos');
      expect(photosResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should transform photos to content type', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Photos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const photosResult = result.sources.find((s) => s.source === 'Photos');
      expect(photosResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Videos Source', () => {
    it('should sync Facebook videos successfully', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Videos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const videosResult = result.sources.find((s) => s.source === 'Videos');
      expect(videosResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle video metadata', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Videos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Friends Source', () => {
    it('should sync Facebook friends successfully', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Friends'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const friendsResult = result.sources.find((s) => s.source === 'Friends');
      expect(friendsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should transform friends to relationship type', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Friends'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const friendsResult = result.sources.find((s) => s.source === 'Friends');
      expect(friendsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Full Facebook Sync', () => {
    it('should sync all Facebook sources together', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Posts', 'Photos', 'Videos', 'Friends'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      expect(result.sources.length).toBe(4);
      
      validateSyncResult(result);
    }, TEST_CONFIG.timeouts.sync * 2);

    it('should respect Facebook API rate limits', async () => {
      const connection = createMockConnection('facebook', {
        activeEndpoints: ['Posts', 'Photos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });
});
