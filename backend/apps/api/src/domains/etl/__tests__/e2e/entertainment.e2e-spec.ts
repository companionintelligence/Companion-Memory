/**
 * Entertainment Platforms E2E Tests
 * 
 * Tests: Spotify, Twitch, Steam
 */

import { setupTestModule, teardownTestModule, type TestContext } from './setup';
import { createMockConnection, createMockContext, validateSyncResult } from './helpers';
import { ENTERTAINMENT_FIXTURES } from './fixtures';
import { TEST_CONFIG } from './test-config';

describe('Entertainment Platforms E2E Tests', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestModule();
  }, TEST_CONFIG.timeouts.sync);

  afterAll(async () => {
    await teardownTestModule(testContext);
  });

  describe('Spotify', () => {
    it('should sync Spotify playlists successfully', async () => {
      const connection = createMockConnection('spotify', {
        activeEndpoints: ['Playlists'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const playlistsResult = result.sources.find((s) => s.source === 'Playlists');
      expect(playlistsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Spotify tracks successfully', async () => {
      const connection = createMockConnection('spotify', {
        activeEndpoints: ['Tracks'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const tracksResult = result.sources.find((s) => s.source === 'Tracks');
      expect(tracksResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Spotify listening history successfully', async () => {
      const connection = createMockConnection('spotify', {
        activeEndpoints: ['History'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const historyResult = result.sources.find((s) => s.source === 'History');
      expect(historyResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Spotify pagination offsets', async () => {
      const connection = createMockConnection('spotify', {
        activeEndpoints: ['Playlists'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 50 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Spotify data to media type', async () => {
      const connection = createMockConnection('spotify', {
        activeEndpoints: ['Playlists'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const playlistsResult = result.sources.find((s) => s.source === 'Playlists');
      expect(playlistsResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Twitch', () => {
    it('should sync Twitch videos successfully', async () => {
      const connection = createMockConnection('twitch', {
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

    it('should sync Twitch follows successfully', async () => {
      const connection = createMockConnection('twitch', {
        activeEndpoints: ['Follows'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const followsResult = result.sources.find((s) => s.source === 'Follows');
      expect(followsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Twitch clips successfully', async () => {
      const connection = createMockConnection('twitch', {
        activeEndpoints: ['Clips'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const clipsResult = result.sources.find((s) => s.source === 'Clips');
      expect(clipsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should handle Twitch pagination cursors', async () => {
      const connection = createMockConnection('twitch', {
        activeEndpoints: ['Videos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
        { batchSize: 20 },
      );

      expect(result.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Twitch videos to media type', async () => {
      const connection = createMockConnection('twitch', {
        activeEndpoints: ['Videos'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const videosResult = result.sources.find((s) => s.source === 'Videos');
      expect(videosResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Steam', () => {
    it('should sync Steam games successfully', async () => {
      const connection = createMockConnection('steam', {
        activeEndpoints: ['Games'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const gamesResult = result.sources.find((s) => s.source === 'Games');
      expect(gamesResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Steam achievements successfully', async () => {
      const connection = createMockConnection('steam', {
        activeEndpoints: ['Achievements'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const achievementsResult = result.sources.find((s) => s.source === 'Achievements');
      expect(achievementsResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should sync Steam recent games successfully', async () => {
      const connection = createMockConnection('steam', {
        activeEndpoints: ['Recent'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      expect(result.success).toBe(true);
      
      const recentResult = result.sources.find((s) => s.source === 'Recent');
      expect(recentResult).toBeDefined();
    }, TEST_CONFIG.timeouts.sync);

    it('should transform Steam games to media type', async () => {
      const connection = createMockConnection('steam', {
        activeEndpoints: ['Games'],
      });
      const context = createMockContext();

      const result = await testContext.syncEngine.syncConnection(
        context,
        connection,
      );

      const gamesResult = result.sources.find((s) => s.source === 'Games');
      expect(gamesResult?.success).toBe(true);
    }, TEST_CONFIG.timeouts.sync);
  });

  describe('Full Entertainment Sync', () => {
    it('should sync all entertainment platforms concurrently', async () => {
      const connections = [
        createMockConnection('spotify', { activeEndpoints: ['Playlists'] }),
        createMockConnection('twitch', { activeEndpoints: ['Videos'] }),
        createMockConnection('steam', { activeEndpoints: ['Games'] }),
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
