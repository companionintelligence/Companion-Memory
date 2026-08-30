import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { BrowserActivityEntity } from '../../entities/BrowserActivityEntity';
import type { CreateBrowserActivityDto } from '../../types';
import { BrowserActivityService } from '../BrowserActivityService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THE ON CONFLICT ARBITER MATCH THE REAL PARTIAL UNIQUE INDEX.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `createManyDetailed` names its ON CONFLICT target as a literal string —
 * `(user_id, source_type, source_system, source_id) WHERE source_id IS NOT
 * NULL` — that has to match `browser_activity_source_triple_uniq`
 * (20260623120200_add_browser_activity_provenance.sql) column-for-column and
 * predicate-for-predicate, or Postgres rejects the statement outright
 * ("there is no unique or exclusion constraint matching the ON CONFLICT
 * specification"). No mock can catch that drift — only a real index can. The
 * shared `bulkInsertIdempotent` helper this method delegates to already has
 * its own generic mocked + integration coverage
 * (common/persistence/__tests__/bulkUpsert.*); what's untested is THIS
 * service's wiring into it, at production scale (325,849 rows per the task
 * brief that flagged this gap) the one place a duplicate here means a user's
 * entire browsing history doubles on re-import.
 */

const BROWSER_ACTIVITY_DATABASE_ENV = {
  urlEnvVar: 'BROWSER_ACTIVITY_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'BROWSER_ACTIVITY_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(BROWSER_ACTIVITY_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(
    `[browser-activity/BrowserActivityService.bulkIngest.integration] SKIPPED — ${availability.reason}`,
  );
}

jest.setTimeout(60_000);

describeWithDatabase(
  `BrowserActivityService bulk ingest against a live Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let service: BrowserActivityService;

    const userId = randomUUID();
    const otherUserId = randomUUID();

    const eventService = { send: jest.fn() } as never;
    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    } as never;

    const row = (over: Partial<CreateBrowserActivityDto> = {}): CreateBrowserActivityDto => ({
      time: new Date().toISOString(),
      url: 'https://example.com/page',
      source_type: 'ci-import-tools',
      source_system: 'chrome_history',
      source_id: `entry-${randomUUID()}`,
      ...over,
    });

    beforeAll(async () => {
      const connection = resolveConnection(BROWSER_ACTIVITY_DATABASE_ENV);

      if (connection == null) {
        throw new Error('databaseAvailability passed but no connection resolved');
      }

      dataSource = new DataSource({
        type: 'postgres',
        ...(connection.url != null
          ? { url: connection.url }
          : {
              host: connection.host,
              port: connection.port,
              username: connection.username,
              password: connection.password,
              database: connection.database,
            }),
        entities: [BrowserActivityEntity, UserEntity],
        synchronize: false,
      });
      await dataSource.initialize();

      service = new BrowserActivityService(
        dataSource.getRepository(BrowserActivityEntity),
        eventService,
        logger,
        dataSource,
      );
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.query('DELETE FROM ci.browser_activity WHERE user_id = ANY($1::uuid[])', [
          [userId, otherUserId],
        ]);
        await dataSource.destroy();
      }
    });

    afterEach(async () => {
      await dataSource.query('DELETE FROM ci.browser_activity WHERE user_id = ANY($1::uuid[])', [
        [userId, otherUserId],
      ]);
    });

    it('the ON CONFLICT arbiter is accepted by Postgres (matches the real partial unique index)', async () => {
      // If the literal string in createManyDetailed drifted from the migration,
      // THIS is where it would surface — as a thrown QueryFailedError, not a
      // silently-wrong result.
      await expect(service.createManyDetailed({ userId } as never, [row()])).resolves.not.toThrow();
    });

    it('re-syncing the same provenance triple returns the existing row instead of duplicating it', async () => {
      const dto = row({ source_id: 'stable-entry-1', title: 'first sync' });

      const first = await service.createManyDetailed({ userId } as never, [dto]);
      expect(first).toHaveLength(1);
      expect(first[0].inserted).toBe(true);

      // Re-ingest: same triple, even with a different `title` — `title` is
      // deliberately absent from INGEST_REFRESH_COLUMNS.browser_activity (it
      // is user-editable via updateBrowserActivity), so the DO UPDATE conflict
      // action refreshes the capture-derived columns but leaves `title` as the
      // arbiter match found it.
      const second = await service.createManyDetailed({ userId } as never, [
        row({ source_id: 'stable-entry-1', title: 'second sync — should NOT win' }),
      ]);
      expect(second).toHaveLength(1);
      expect(second[0].inserted).toBe(false);
      expect(second[0].entity.id).toBe(first[0].entity.id);

      const stored = await dataSource.query(
        'SELECT id, title FROM ci.browser_activity WHERE user_id = $1::uuid AND source_id = $2',
        [userId, 'stable-entry-1'],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0].title).toBe('first sync');
    });

    it('createManyDetailed reports inserted vs skipped correctly within one mixed batch', async () => {
      const existing = row({ source_id: 'already-there' });
      await service.createManyDetailed({ userId } as never, [existing]);

      const results = await service.createManyDetailed({ userId } as never, [
        row({ source_id: 'already-there' }), // duplicate of the pre-existing row
        row({ source_id: 'brand-new' }), // genuinely new
      ]);

      expect(results.map((r) => r.inserted)).toEqual([false, true]);

      const count = await dataSource.query(
        'SELECT count(*)::int AS n FROM ci.browser_activity WHERE user_id = $1::uuid',
        [userId],
      );
      expect(count[0].n).toBe(2);
    });

    it('scopes the conflict arbiter to user_id: two users importing the same external triple do not collide', async () => {
      const dto = row({ source_id: 'shared-across-users' });

      const forUserA = await service.createManyDetailed({ userId } as never, [dto]);
      const forUserB = await service.createManyDetailed({ userId: otherUserId } as never, [dto]);

      // Same (source_type, source_system, source_id) triple, different owners —
      // both must insert. If the arbiter dropped `user_id`, the second call
      // would incorrectly report `inserted: false` against the first user's row.
      expect(forUserA[0].inserted).toBe(true);
      expect(forUserB[0].inserted).toBe(true);
      expect(forUserA[0].entity.id).not.toBe(forUserB[0].entity.id);
    });
  },
);
