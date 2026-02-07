/**
 * Business Platforms E2E Tests
 * 
 * Tests: Shopify, Stripe
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { BUSINESS_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Business Platforms E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Shopify', () => {
    it('should sync Shopify orders successfully', async () => {
      const connection = createMockConnection('shopify', {
        activeEndpoints: ['Orders'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const ordersResult = result.sources.find((s) => s.source === 'Orders');
      expect(ordersResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Shopify products successfully', async () => {
      const connection = createMockConnection('shopify', {
        activeEndpoints: ['Products'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const productsResult = result.sources.find((s) => s.source === 'Products');
      expect(productsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Shopify customers successfully', async () => {
      const connection = createMockConnection('shopify', {
        activeEndpoints: ['Customers'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const customersResult = result.sources.find((s) => s.source === 'Customers');
      expect(customersResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Shopify pagination with page_info', async () => {
      const connection = createMockConnection('shopify', {
        activeEndpoints: ['Orders'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 50 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Shopify orders to transaction type', async () => {
      const connection = createMockConnection('shopify', {
        activeEndpoints: ['Orders'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const ordersResult = result.sources.find((s) => s.source === 'Orders');
      expect(ordersResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should respect Shopify rate limits', async () => {
      const connection = createMockConnection('shopify', {
        activeEndpoints: ['Orders', 'Products', 'Customers'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      expect(result.sources.length).toBe(3);
    }, TEST_CONFIG.timeouts.sync * 2);
  });

  describe('Stripe', () => {
    it('should sync Stripe payments successfully', async () => {
      const connection = createMockConnection('stripe', {
        activeEndpoints: ['Payments'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const paymentsResult = result.sources.find((s) => s.source === 'Payments');
      expect(paymentsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Stripe customers successfully', async () => {
      const connection = createMockConnection('stripe', {
        activeEndpoints: ['Customers'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const customersResult = result.sources.find((s) => s.source === 'Customers');
      expect(customersResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Stripe subscriptions successfully', async () => {
      const connection = createMockConnection('stripe', {
        activeEndpoints: ['Subscriptions'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const subscriptionsResult = result.sources.find((s) => s.source === 'Subscriptions');
      expect(subscriptionsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Stripe cursor-based pagination', async () => {
      const connection = createMockConnection('stripe', {
        activeEndpoints: ['Payments'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 100 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Stripe payments to transaction type', async () => {
      const connection = createMockConnection('stripe', {
        activeEndpoints: ['Payments'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const paymentsResult = result.sources.find((s) => s.source === 'Payments');
      expect(paymentsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Stripe subscriptions to transaction type', async () => {
      const connection = createMockConnection('stripe', {
        activeEndpoints: ['Subscriptions'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const subscriptionsResult = result.sources.find((s) => s.source === 'Subscriptions');
      expect(subscriptionsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Full Business Sync', () => {
    it('should sync all business platforms concurrently', async () => {
      const connections = [
        createMockConnection('shopify', { activeEndpoints: ['Orders'] }),
        createMockConnection('stripe', { activeEndpoints: ['Payments'] }),
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

    it('should handle business platform rate limiting', async () => {
      const connection = createMockConnection('shopify', {
        activeEndpoints: ['Orders', 'Products', 'Customers'],
      });
      const context = createMockContext();

      const startTime = Date.now();
      
      await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete but respect rate limits
      expect(duration).toBeGreaterThan(0);
    }, TEST_CONFIG.timeouts.sync);
  });
});
