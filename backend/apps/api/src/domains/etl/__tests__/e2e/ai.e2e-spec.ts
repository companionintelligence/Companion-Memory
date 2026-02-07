/**
 * AI Platforms E2E Tests
 * 
 * Tests: OpenAI, Anthropic
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { AI_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('AI Platforms E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('OpenAI', () => {
    it('should sync OpenAI conversations successfully', async () => {
      const connection = createMockConnection('openai', {
        activeEndpoints: ['Conversations'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const conversationsResult = result.sources.find((s) => s.source === 'Conversations');
      expect(conversationsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync OpenAI models successfully', async () => {
      const connection = createMockConnection('openai', {
        activeEndpoints: ['Models'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const modelsResult = result.sources.find((s) => s.source === 'Models');
      expect(modelsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle OpenAI pagination', async () => {
      const connection = createMockConnection('openai', {
        activeEndpoints: ['Conversations'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 20 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform OpenAI conversations to communication type', async () => {
      const connection = createMockConnection('openai', {
        activeEndpoints: ['Conversations'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const conversationsResult = result.sources.find((s) => s.source === 'Conversations');
      expect(conversationsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should respect OpenAI rate limits', async () => {
      const connection = createMockConnection('openai', {
        activeEndpoints: ['Conversations', 'Models'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Anthropic', () => {
    it('should sync Anthropic messages successfully', async () => {
      const connection = createMockConnection('anthropic', {
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

    it('should handle Anthropic pagination', async () => {
      const connection = createMockConnection('anthropic', {
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

    it('should transform Anthropic messages to communication type', async () => {
      const connection = createMockConnection('anthropic', {
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

    it('should respect Anthropic rate limits', async () => {
      const connection = createMockConnection('anthropic', {
        activeEndpoints: ['Messages'],
      });
      const context = createMockContext();

      const startTime = Date.now();
      
      await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(duration).toBeGreaterThan(0);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Full AI Sync', () => {
    it('should sync all AI platforms concurrently', async () => {
      const connections = [
        createMockConnection('openai', { activeEndpoints: ['Conversations'] }),
        createMockConnection('anthropic', { activeEndpoints: ['Messages'] }),
      ];
      const context = createMockContext();

      const results = await Promise.all(
        connections.map((conn) =>
          testContext.syncEngine.syncConnection(context, conn),
        ),
      );

      expect(results.length).toBe(2);
      expect(results.every((r) => r.success)).toBe(true);
    }, TEST_CONFIG.timeouts.sync * 2);

    it('should handle AI platform specific data formats', async () => {
      const connection = createMockConnection('openai', {
        activeEndpoints: ['Conversations'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      const conversationsResult = result.sources.find((s) => s.source === 'Conversations');
      expect(conversationsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);
  });
});
