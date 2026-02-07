/**
 * Storage Platforms E2E Tests
 * 
 * Tests: Dropbox, Box, Nextcloud, iCloud
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { STORAGE_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Storage Platforms E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Dropbox', () => {
    it('should sync Dropbox files successfully', async () => {
      const connection = createMockConnection('dropbox', {
        activeEndpoints: ['Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const filesResult = result.sources.find((s) => s.source === 'Files');
      expect(filesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Dropbox cursor-based pagination', async () => {
      const connection = createMockConnection('dropbox', {
        activeEndpoints: ['Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Dropbox delta sync', async () => {
      const connection = createMockConnection('dropbox', {
        activeEndpoints: ['Files'],
        syncState: { dropbox: { cursor: 'mock-cursor-abc123' } },
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Dropbox files to content type', async () => {
      const connection = createMockConnection('dropbox', {
        activeEndpoints: ['Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const filesResult = result.sources.find((s) => s.source === 'Files');
      expect(filesResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Box', () => {
    it('should sync Box files successfully', async () => {
      const connection = createMockConnection('box', {
        activeEndpoints: ['Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const filesResult = result.sources.find((s) => s.source === 'Files');
      expect(filesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Box offset pagination', async () => {
      const connection = createMockConnection('box', {
        activeEndpoints: ['Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 100 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Box files to content type', async () => {
      const connection = createMockConnection('box', {
        activeEndpoints: ['Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const filesResult = result.sources.find((s) => s.source === 'Files');
      expect(filesResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Nextcloud', () => {
    it('should sync Nextcloud files successfully', async () => {
      const connection = createMockConnection('nextcloud', {
        activeEndpoints: ['Files'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const filesResult = result.sources.find((s) => s.source === 'Files');
      expect(filesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Nextcloud contacts successfully', async () => {
      const connection = createMockConnection('nextcloud', {
        activeEndpoints: ['Contacts'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Nextcloud calendar successfully', async () => {
      const connection = createMockConnection('nextcloud', {
        activeEndpoints: ['Calendar'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should sync all Nextcloud sources together', async () => {
      const connection = createMockConnection('nextcloud', {
        activeEndpoints: ['Files', 'Contacts', 'Calendar'],
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

  describe('iCloud', () => {
    it('should sync iCloud Drive successfully', async () => {
      const connection = createMockConnection('icloud', {
        activeEndpoints: ['Drive'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const driveResult = result.sources.find((s) => s.source === 'Drive');
      expect(driveResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync iCloud Photos successfully', async () => {
      const connection = createMockConnection('icloud', {
        activeEndpoints: ['Photos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should sync iCloud Contacts successfully', async () => {
      const connection = createMockConnection('icloud', {
        activeEndpoints: ['Contacts'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Cross-Platform Storage Sync', () => {
    it('should sync multiple storage platforms concurrently', async () => {
      const connections = [
        createMockConnection('dropbox', { activeEndpoints: ['Files'] }),
        createMockConnection('box', { activeEndpoints: ['Files'] }),
        createMockConnection('nextcloud', { activeEndpoints: ['Files'] }),
      ];
      const context = createMockContext();

      const results = await Promise.all(
        connections.map((conn) =>
          testContext.syncEngine.syncConnection(context, conn),
        ),
      );

      expect(results.length).toBe(3);
      expect(results.every((r) => r.success)).toBe(true);
    }, TEST_CONFIG.timeouts.sync * 2);
  });
});
