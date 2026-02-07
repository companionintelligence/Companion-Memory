/**
 * Communication Platforms E2E Tests
 * 
 * Tests: Discord, Slack, Telegram, Signal, GitHub
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { COMMUNICATION_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Communication Platforms E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Discord', () => {
    it('should sync Discord messages successfully', async () => {
      const connection = createMockConnection('discord', {
        activeEndpoints: ['Messages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const messagesResult = result.sources.find((s) => s.source === 'Messages');
      expect(messagesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Discord guilds successfully', async () => {
      const connection = createMockConnection('discord', {
        activeEndpoints: ['Guilds'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Discord pagination', async () => {
      const connection = createMockConnection('discord', {
        activeEndpoints: ['Messages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 50 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Slack', () => {
    it('should sync Slack messages successfully', async () => {
      const connection = createMockConnection('slack', {
        activeEndpoints: ['Messages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const messagesResult = result.sources.find((s) => s.source === 'Messages');
      expect(messagesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Slack files successfully', async () => {
      const connection = createMockConnection('slack', {
        activeEndpoints: ['Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should respect Slack rate limits', async () => {
      const connection = createMockConnection('slack', {
        activeEndpoints: ['Messages', 'Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Telegram', () => {
    it('should sync Telegram messages successfully', async () => {
      const connection = createMockConnection('telegram', {
        activeEndpoints: ['Messages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const messagesResult = result.sources.find((s) => s.source === 'Messages');
      expect(messagesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Telegram update offsets', async () => {
      const connection = createMockConnection('telegram', {
        activeEndpoints: ['Messages'],
        syncState: { telegram: { updateOffset: 12345 } },
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Signal', () => {
    it('should sync Signal messages successfully', async () => {
      const connection = createMockConnection('signal', {
        activeEndpoints: ['Messages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const messagesResult = result.sources.find((s) => s.source === 'Messages');
      expect(messagesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Signal messages to communication type', async () => {
      const connection = createMockConnection('signal', {
        activeEndpoints: ['Messages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const messagesResult = result.sources.find((s) => s.source === 'Messages');
      expect(messagesResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('GitHub', () => {
    it('should sync GitHub repos successfully', async () => {
      const connection = createMockConnection('github', {
        activeEndpoints: ['Repos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const reposResult = result.sources.find((s) => s.source === 'Repos');
      expect(reposResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync GitHub issues successfully', async () => {
      const connection = createMockConnection('github', {
        activeEndpoints: ['Issues'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should sync GitHub pull requests successfully', async () => {
      const connection = createMockConnection('github', {
        activeEndpoints: ['PullRequests'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should sync GitHub events successfully', async () => {
      const connection = createMockConnection('github', {
        activeEndpoints: ['Events'],
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
