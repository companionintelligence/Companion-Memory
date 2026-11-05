import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER } from '@ci/common/context';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PositionSearchIndexListener } from '../PositionSearchIndexListener';

/**
 * `PositionSearchIndexListener.isHourCellRepresentative` — the raw PostGIS
 * downsample query, proved against real Postgres.
 *
 * A phone can write a GPS ping every few seconds; indexing every one of them
 * would flood the search index with near-duplicate "at 123 Main St" rows for
 * the same hour spent in one place. This query is the downsample: of every
 * ping sharing an (hour, 3-decimal-place lat/lng) cell, only the EARLIEST
 * (`ORDER BY time, id LIMIT 1`) is "representative" and gets embedded; the rest
 * are recorded with a `downsampled` skip marker. A unit test mocking the
 * DataSource cannot show that this SQL actually identifies the right row — it
 * can only show the listener calls `.query()` with something.
 *
 * Opt-in: set `SEARCH_INGRESS_TEST_DATABASE_URL` (or `DATABASE_URL` /
 * `DATABASE_PASSWORD`, as `yarn test` already does from the repo-root `.env`)
 * to a database with migrations applied.
 */
const availability = databaseAvailability({ urlEnvVar: 'SEARCH_INGRESS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-ingress/PositionSearchIndexListener.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`PositionSearchIndexListener — against real Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  const userId = uuidv7();

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'SEARCH_INGRESS_TEST_DATABASE_URL' });

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
      entities: [],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits real ci.users / ci.position rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'PositionSearchIndexListener');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
         VALUES ($1, 'Position Test', $2, 'x', true, 'UTC')
         ON CONFLICT (id) DO NOTHING`,
      [userId, `position.${userId}@example.test`],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the position rows with the user.
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  function makeListener() {
    const positionService = { findById: jest.fn() };
    const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
    const embeddingService = {
      upsertDocument: jest.fn(
        async (_ctx: unknown, data: { text: string }, generate: (text: string) => Promise<number[]>) => {
          await generate(data.text);

          return 'embedded';
        },
      ),
      upsert: jest.fn().mockResolvedValue(null),
      remove: jest.fn(),
    };
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
      dataSource,
      logger as never,
    );

    return {
      listener,
      positionService,
      embeddingGenerationService,
      embeddingService,
      indexSkipService,
      vectorService,
      logger,
    };
  }

  /**
   * Seed one raw ci.position row and return its (id, time, position-shaped
   * fixture). `hour` is caller-supplied (not shared across tests) because the
   * table's primary key is `(time, user_id)` — two tests reusing the same
   * (hour, minute) for this user would collide.
   */
  async function seedPing(
    hour: number,
    minuteOffset: number,
    overrides: { address?: string | null; lng?: number; lat?: number } = {},
  ) {
    const id = uuidv7();
    const time = new Date(
      `2026-08-10T${String(hour).padStart(2, '0')}:${String(minuteOffset).padStart(2, '0')}:00.000Z`,
    );
    const lng = overrides.lng ?? -122.4194;
    const lat = overrides.lat ?? 37.7749;
    const address = overrides.address === undefined ? '1 Market St, San Francisco, CA' : overrides.address;

    await dataSource.query(
      `INSERT INTO ci.position (time, user_id, id, location, address, source)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, 'gps')`,
      [time, userId, id, lng, lat, address],
    );

    return {
      id,
      userId,
      time,
      address,
      city: null,
      region: null,
      country: null,
      location: { type: 'Point' as const, coordinates: [lng, lat] },
    };
  }

  it('indexes only the EARLIEST ping in a shared hour-cell; the rest are recorded as downsampled', async () => {
    const early = await seedPing(14, 5); // 14:05
    const middle = await seedPing(14, 20); // 14:20 — same hour, same spot
    const late = await seedPing(14, 45); // 14:45 — same hour, same spot

    for (const ping of [early, middle, late]) {
      const { listener, positionService, embeddingService, indexSkipService } = makeListener();
      positionService.findById.mockResolvedValue(ping);

      await listener.indexPosition({ positionId: ping.id } as never);

      if (ping.id === early.id) {
        expect(embeddingService.upsertDocument).toHaveBeenCalledWith(
          { userId },
          expect.objectContaining({ entityType: 'position', entityId: early.id }),
          expect.any(Function),
        );
        expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
          entityType: 'position',
          entityId: early.id,
        });
        expect(indexSkipService.recordSkip).not.toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'downsampled' }),
        );
      } else {
        expect(embeddingService.upsertDocument).not.toHaveBeenCalled();
        expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
          entityType: 'position',
          entityId: ping.id,
          reason: 'downsampled',
        });
      }
    }
  });

  it('a ping in a DIFFERENT hour-cell (same spot) is independently representative', async () => {
    const hour16 = await seedPing(16, 5);
    const hour17 = await seedPing(17, 5); // same minute/spot, one hour later

    for (const ping of [hour16, hour17]) {
      const { listener, positionService, embeddingService } = makeListener();
      positionService.findById.mockResolvedValue(ping);

      await listener.indexPosition({ positionId: ping.id } as never);

      expect(embeddingService.upsertDocument).toHaveBeenCalledWith(
        { userId },
        expect.objectContaining({ entityType: 'position', entityId: ping.id }),
        expect.any(Function),
      );
    }
  });

  it('a ping at a DIFFERENT place in the same hour is independently representative', async () => {
    const home = await seedPing(18, 5, { lng: -122.4194, lat: 37.7749, address: 'Home' });
    const work = await seedPing(18, 10, { lng: -122.401, lat: 37.789, address: 'Work' }); // >0.001° away — different rounded cell

    for (const ping of [home, work]) {
      const { listener, positionService, embeddingService } = makeListener();
      positionService.findById.mockResolvedValue(ping);

      await listener.indexPosition({ positionId: ping.id } as never);

      expect(embeddingService.upsertDocument).toHaveBeenCalledWith(
        { userId },
        expect.objectContaining({ entityType: 'position', entityId: ping.id }),
        expect.any(Function),
      );
    }
  });

  it("uses the user's real ci.users.timezone when stamping the indexed text", async () => {
    const tzUserId = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
         VALUES ($1, 'TZ Test', $2, 'x', true, 'America/Los_Angeles')
         ON CONFLICT (id) DO NOTHING`,
      [tzUserId, `position-tz.${tzUserId}@example.test`],
    );

    try {
      const id = uuidv7();
      const time = new Date('2026-08-10T20:00:00.000Z'); // 13:00 PDT
      await dataSource.query(
        `INSERT INTO ci.position (time, user_id, id, location, address, source)
           VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, 'gps')`,
        [time, tzUserId, id, -122.4194, 37.7749, 'A place'],
      );

      const { listener, positionService, embeddingGenerationService } = makeListener();
      positionService.findById.mockResolvedValue({
        id,
        userId: tzUserId,
        time,
        address: 'A place',
        city: null,
        region: null,
        country: null,
        location: { type: 'Point' as const, coordinates: [-122.4194, 37.7749] },
      });

      await listener.indexPosition({ positionId: id } as never);

      expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(
        expect.stringContaining('2026-08-10 13:00 at A place'),
      );
    } finally {
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [tzUserId]);
    }
  });

  it('unindexPosition removes both the embedding and the vector under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexPosition({ positionId: 'gone' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'position', entityId: 'gone' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'position', entityId: 'gone' },
    );
  });
});
