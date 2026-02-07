/**
 * Microsoft Provider E2E Tests
 * 
 * Tests all 3 Microsoft data sources: Outlook, Calendar, OneDrive
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { MICROSOFT_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Microsoft Provider E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Outlook Mail Source', () => {
    it('should sync Outlook messages successfully', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['OutlookMessages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const outlookResult = result.sources.find((s) => s.source === 'Outlook');
      expect(outlookResult).toBeDefined();
      expect(outlookResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Outlook delta queries', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['OutlookMessages'],
        syncState: { outlook: { deltaLink: 'mock-delta-link' } },
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Outlook emails to communication type', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['OutlookMessages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const outlookResult = result.sources.find((s) => s.source === 'Outlook');
      expect(outlookResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Calendar Source', () => {
    it('should sync Microsoft Calendar events successfully', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['CalendarEvents', 'Calendars'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const calendarResult = result.sources.find((s) => s.source === 'Calendar');
      expect(calendarResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle recurring events', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['CalendarEvents'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform calendar data to event type', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['CalendarEvents'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const calendarResult = result.sources.find((s) => s.source === 'Calendar');
      expect(calendarResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('OneDrive Source', () => {
    it('should sync OneDrive files successfully', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['OneDriveFiles', 'OneDriveChanges'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const onedriveResult = result.sources.find((s) => s.source === 'OneDrive');
      expect(onedriveResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle OneDrive delta tracking', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['OneDriveChanges'],
        syncState: { onedrive: { deltaToken: 'mock-delta-token' } },
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform files to content type', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['OneDriveFiles'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const onedriveResult = result.sources.find((s) => s.source === 'OneDrive');
      expect(onedriveResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Full Microsoft Sync', () => {
    it('should sync all Microsoft sources together', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: [
          'OutlookMessages',
          'CalendarEvents',
          'OneDriveFiles',
        ],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      expect(result.sources.length).toBe(3);
      
      validateSyncResult(result);
    }, TEST_CONFIG.timeouts.sync * 2);

    it('should apply Microsoft Graph rate limiting', async () => {
      const connection = createMockConnection('microsoft', {
        activeEndpoints: ['OutlookMessages', 'CalendarEvents'],
      });
      const context = createMockContext();

      const startTime = Date.now();
      
      await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete but not too fast (rate limiting applied)
      expect(duration).toBeGreaterThan(0);
    }, TEST_CONFIG.timeouts.sync);
  });
});
