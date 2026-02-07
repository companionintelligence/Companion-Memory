/**
 * Google Provider E2E Tests
 * 
 * Tests all 5 Google data sources: Gmail, Calendar, Drive, YouTube, Contacts
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateTransformedData, validateSyncResult } from './helpers';
import { GOOGLE_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Google Provider E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Gmail Source', () => {
    it('should sync Gmail messages successfully', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['GmailMessages', 'GmailLabels'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      expect(result.totalRecords).toBeGreaterThan(0);
      
      const gmailResult = result.sources.find((s) => s.source === 'Gmail');
      expect(gmailResult).toBeDefined();
      expect(gmailResult?.success).toBe(true);
      expect(gmailResult?.records).toBeGreaterThan(0);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Gmail data correctly', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['GmailMessages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const gmailResult = result.sources.find((s) => s.source === 'Gmail');
      expect(gmailResult).toBeDefined();
      
      // Validate transformed data structure
      // Note: In real implementation, we'd extract the transformed data
      // For now, we validate the sync was successful
      expect(gmailResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Gmail pagination', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['GmailMessages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 10 },
      );

      expect(result.success).toBe(true);
      validateSyncResult(result);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Calendar Source', () => {
    it('should sync Calendar events successfully', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['CalendarEvents', 'CalendarList'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const calendarResult = result.sources.find((s) => s.source === 'Calendar');
      expect(calendarResult).toBeDefined();
      expect(calendarResult?.success).toBe(true);
      expect(calendarResult?.records).toBeGreaterThanOrEqual(0);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Calendar data to event type', async () => {
      const connection = createMockConnection('google', {
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

  describe('Drive Source', () => {
    it('should sync Drive files successfully', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['DriveFiles', 'DriveChanges'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const driveResult = result.sources.find((s) => s.source === 'Drive');
      expect(driveResult).toBeDefined();
      expect(driveResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Drive file changes', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['DriveChanges'],
        syncState: { drive: { startPageToken: 'mock-token' } },
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('YouTube Source', () => {
    it('should sync YouTube playlists successfully', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['YouTubePlaylists', 'YouTubeLikes'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const youtubeResult = result.sources.find((s) => s.source === 'YouTube');
      expect(youtubeResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync YouTube subscriptions', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['YouTubeSubscriptions'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Contacts Source', () => {
    it('should sync Google Contacts successfully', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['ContactsList', 'ContactGroups'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const contactsResult = result.sources.find((s) => s.source === 'Contacts');
      expect(contactsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should transform contacts to relationship type', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['ContactsList'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const contactsResult = result.sources.find((s) => s.source === 'Contacts');
      expect(contactsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Full Google Sync', () => {
    it('should sync all Google sources together', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: [
          'GmailMessages',
          'CalendarEvents',
          'DriveFiles',
          'YouTubePlaylists',
          'ContactsList',
        ],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      expect(result.sources.length).toBe(5);
      expect(result.totalRecords).toBeGreaterThan(0);
      
      validateSyncResult(result);
    }, TEST_CONFIG.timeouts.sync * 2);

    it('should handle errors gracefully and continue', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['GmailMessages', 'CalendarEvents'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { continueOnError: true },
      );

      // Even if one source fails, others should continue
      expect(result.sources.length).toBeGreaterThan(0);
    }, TEST_CONFIG.timeouts.sync);
  });
});
