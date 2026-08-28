import {
  formatLocalPositionStamp,
  PositionSearchIndexListener,
  TIMEZONE_CACHE_TTL_MS,
} from '../PositionSearchIndexListener';

describe('formatLocalPositionStamp', () => {
  it('renders the user-local wall clock, not UTC', () => {
    // 20:00 UTC on 6 Jul 2026 is 13:00 PDT.
    const stamp = formatLocalPositionStamp(new Date('2026-07-06T20:00:00Z'), 'America/Los_Angeles');

    expect(stamp).toBe('2026-07-06 13:00');
  });

  it('falls back to UTC when the zone is missing or invalid', () => {
    const when = new Date('2026-07-06T20:00:00Z');

    expect(formatLocalPositionStamp(when, '')).toBe('2026-07-06 20:00');
    expect(formatLocalPositionStamp(when, 'Not/AZone')).toBe('2026-07-06 20:00');
  });
});

const USER_ID = 'user-1';
const POSITION_ID = 'position-1';

function makePosition() {
  return {
    id: POSITION_ID,
    userId: USER_ID,
    time: new Date('2026-08-10T20:00:00.000Z'),
    address: '1 Market St, San Francisco, CA',
    city: null,
    region: null,
    country: null,
    location: { type: 'Point' as const, coordinates: [-122.4194, 37.7749] },
  };
}

/**
 * A fake `DataSource` standing in for real Postgres: it answers the
 * `ci.users` timezone lookup from `timezoneRef` (mutable so a test can change
 * it mid-run) and always tells `isHourCellRepresentative` that
 * {@link POSITION_ID} is the representative ping, so `upsertPosition` runs to
 * completion without a database.
 */
function makeDataSource(timezoneRef: { value: string | null }) {
  const query = jest.fn(async (sql: string) => {
    if (/FROM ci\.users/i.test(sql)) {
      return [{ timezone: timezoneRef.value }];
    }

    if (/FROM ci\.position/i.test(sql)) {
      return [{ id: POSITION_ID }];
    }

    return [];
  });

  return { query };
}

function makeListener(dataSource: { query: jest.Mock }) {
  const positionService = { findById: jest.fn().mockResolvedValue(makePosition()) };
  const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const embeddingService = { upsert: jest.fn().mockResolvedValue(null), remove: jest.fn() };
  const indexSkipService = {
    recordSkip: jest.fn().mockResolvedValue(undefined),
    clearSkip: jest.fn().mockResolvedValue(true),
  };
  const vectorService = { upsert: jest.fn().mockResolvedValue(null), remove: jest.fn() };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new PositionSearchIndexListener(
    positionService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    indexSkipService as never,
    vectorService as never,
    dataSource as never,
    logger as never,
  );

  return {
    listener,
    positionService,
    embeddingGenerationService,
    embeddingService,
    indexSkipService,
    vectorService,
  };
}

describe('PositionSearchIndexListener', () => {
  it('updatePosition indexes the position through the shared upsert path', async () => {
    const dataSource = makeDataSource({ value: 'UTC' });
    const { listener, embeddingService, indexSkipService } = makeListener(dataSource);

    await listener.updatePosition({ positionId: POSITION_ID } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: USER_ID },
      expect.objectContaining({ entityType: 'position', entityId: POSITION_ID }),
    );
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'position',
      entityId: POSITION_ID,
    });
  });

  describe('the per-user timezone cache', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('reuses the cached timezone within the TTL instead of re-querying ci.users', async () => {
      const dataSource = makeDataSource({ value: 'America/Los_Angeles' });
      const { listener } = makeListener(dataSource);

      await listener.indexPosition({ positionId: POSITION_ID } as never);
      await listener.indexPosition({ positionId: POSITION_ID } as never);

      const userLookups = dataSource.query.mock.calls.filter(([sql]) =>
        /FROM ci\.users/i.test(sql as string),
      );
      expect(userLookups).toHaveLength(1);
    });

    it('re-fetches after the TTL elapses and picks up a changed timezone', async () => {
      const timezoneRef = { value: 'UTC' };
      const dataSource = makeDataSource(timezoneRef);
      const { listener, embeddingGenerationService } = makeListener(dataSource);

      await listener.indexPosition({ positionId: POSITION_ID } as never);
      expect(embeddingGenerationService.generateEmbedding).toHaveBeenLastCalledWith(
        expect.stringContaining('2026-08-10 20:00 at'),
      );

      // A user changing their timezone setting after the first lookup — without
      // the TTL this would never be observed until the process restarts.
      timezoneRef.value = 'America/Los_Angeles';
      jest.advanceTimersByTime(TIMEZONE_CACHE_TTL_MS + 1);

      await listener.indexPosition({ positionId: POSITION_ID } as never);
      expect(embeddingGenerationService.generateEmbedding).toHaveBeenLastCalledWith(
        expect.stringContaining('2026-08-10 13:00 at'),
      );

      const userLookups = dataSource.query.mock.calls.filter(([sql]) =>
        /FROM ci\.users/i.test(sql as string),
      );
      expect(userLookups).toHaveLength(2);
    });
  });
});
