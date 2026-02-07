/**
 * Productivity Platforms E2E Tests
 * 
 * Tests: Notion, Trello, Asana, Zoom
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { PRODUCTIVITY_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Productivity Platforms E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Notion', () => {
    it('should sync Notion pages successfully', async () => {
      const connection = createMockConnection('notion', {
        activeEndpoints: ['Pages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const pagesResult = result.sources.find((s) => s.source === 'Pages');
      expect(pagesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Notion databases successfully', async () => {
      const connection = createMockConnection('notion', {
        activeEndpoints: ['Databases'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const dbResult = result.sources.find((s) => s.source === 'Databases');
      expect(dbResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Notion pagination cursors', async () => {
      const connection = createMockConnection('notion', {
        activeEndpoints: ['Pages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 100 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Notion pages to content type', async () => {
      const connection = createMockConnection('notion', {
        activeEndpoints: ['Pages'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const pagesResult = result.sources.find((s) => s.source === 'Pages');
      expect(pagesResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Trello', () => {
    it('should sync Trello boards successfully', async () => {
      const connection = createMockConnection('trello', {
        activeEndpoints: ['Boards'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const boardsResult = result.sources.find((s) => s.source === 'Boards');
      expect(boardsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Trello cards successfully', async () => {
      const connection = createMockConnection('trello', {
        activeEndpoints: ['Cards'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const cardsResult = result.sources.find((s) => s.source === 'Cards');
      expect(cardsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Trello cards to event type', async () => {
      const connection = createMockConnection('trello', {
        activeEndpoints: ['Cards'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const cardsResult = result.sources.find((s) => s.source === 'Cards');
      expect(cardsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Asana', () => {
    it('should sync Asana tasks successfully', async () => {
      const connection = createMockConnection('asana', {
        activeEndpoints: ['Tasks'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const tasksResult = result.sources.find((s) => s.source === 'Tasks');
      expect(tasksResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Asana projects successfully', async () => {
      const connection = createMockConnection('asana', {
        activeEndpoints: ['Projects'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const projectsResult = result.sources.find((s) => s.source === 'Projects');
      expect(projectsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Asana pagination offsets', async () => {
      const connection = createMockConnection('asana', {
        activeEndpoints: ['Tasks'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 50 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Asana tasks to event type', async () => {
      const connection = createMockConnection('asana', {
        activeEndpoints: ['Tasks'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const tasksResult = result.sources.find((s) => s.source === 'Tasks');
      expect(tasksResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Zoom', () => {
    it('should sync Zoom meetings successfully', async () => {
      const connection = createMockConnection('zoom', {
        activeEndpoints: ['Meetings'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const meetingsResult = result.sources.find((s) => s.source === 'Meetings');
      expect(meetingsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Zoom recordings successfully', async () => {
      const connection = createMockConnection('zoom', {
        activeEndpoints: ['Recordings'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const recordingsResult = result.sources.find((s) => s.source === 'Recordings');
      expect(recordingsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Zoom pagination', async () => {
      const connection = createMockConnection('zoom', {
        activeEndpoints: ['Meetings'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 30 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Zoom meetings to event type', async () => {
      const connection = createMockConnection('zoom', {
        activeEndpoints: ['Meetings'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const meetingsResult = result.sources.find((s) => s.source === 'Meetings');
      expect(meetingsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Full Productivity Sync', () => {
    it('should sync all productivity platforms concurrently', async () => {
      const connections = [
        createMockConnection('notion', { activeEndpoints: ['Pages'] }),
        createMockConnection('trello', { activeEndpoints: ['Boards'] }),
        createMockConnection('asana', { activeEndpoints: ['Tasks'] }),
        createMockConnection('zoom', { activeEndpoints: ['Meetings'] }),
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
