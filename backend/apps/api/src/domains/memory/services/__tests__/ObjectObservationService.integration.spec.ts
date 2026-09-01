import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ObjectObservationEntity } from '../../entities/ObjectObservationEntity';
import { platformIdentity } from '../../identity';
import { ObjectObservationService } from '../ObjectObservationService';

/**
 * The SQL-shaped guarantees `ObjectObservationService.spec.ts` can only assert
 * by string-matching the emitted statement, EXECUTED against real Postgres.
 *
 * That file's header docstring has claimed since it was written that these
 * guarantees are "proved against real Postgres in the gated block at the
 * end" — there was no such block; every one of the following was only ever
 * checked by grepping the SQL text a mock captured. A mock cannot know that
 * `ST_MakePoint(u.lon, u.lat)` is the CORRECT argument order (Postgres wants
 * X, Y — lon, then lat) as opposed to a plausible-looking transposition, or
 * that `WHERE NOT o.confirmed_by_user` actually excludes the row it names
 * rather than a typo'd always-true predicate, or that the two `COALESCE(...)
 * || excluded....` clauses really merge instead of one of them silently
 * replacing. All four are executed here:
 *
 *  1. Both `ON CONFLICT` arbiters (source triple, derived detection key)
 *     genuinely dedupe a real re-detection into an UPDATE, not a second row.
 *  2. The resolution columns are excluded from `DO UPDATE SET` in fact, not
 *     merely absent from the SQL text — an unconfirmed row's re-detection
 *     refreshes its detection columns while its resolution survives.
 *  3. The confirmation guard freezes a confirmed row entirely, detection
 *     columns included, by executing a real re-detection against one and
 *     reading back what changed (nothing).
 *  4. `attributes`/`metadata` MERGE across a re-detection instead of one
 *     writer's bag clobbering the other's.
 *  5. `ST_MakePoint(lon, lat)` lands coordinates the right way round — read
 *     back through `ST_X`/`ST_Y`, which only agree with the input if the
 *     call ordered its arguments correctly.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database
 * with the migrations applied — `databaseAvailability` probes it and this
 * suite SKIPS legibly, never fails, when nothing is reachable.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest ObjectObservationService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ObjectObservationService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ObjectObservationService — the write statement, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ObjectObservationService;

  const owner = { userId: uuidv7() };

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });

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
      entities: [ObjectObservationEntity],
    });
    await dataSource.initialize();

    // SHARED: this suite commits rows in ci.object_observations/ci.users,
    // which a migration suite may be altering inside its own transaction. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ObjectObservationService.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email)
            VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [owner.userId, 'Owner spec fixture', `owner.${owner.userId}@example.invalid`],
    );

    service = new ObjectObservationService(
      dataSource.getRepository(ObjectObservationEntity),
      dataSource,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.object_observations WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      // Before destroy(): the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const countRows = async (contentId: string): Promise<number> => {
    const [{ count }] = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM ci.object_observations WHERE content_id = $1',
      [contentId],
    );

    return count as number;
  };

  const rawRow = async (id: string) => {
    const [row] = await dataSource.query(
      `SELECT label, bbox, attributes, metadata, resolved_object_id, resolution_method,
              resolution_confidence, confirmed_by_user,
              ST_X(location_coordinates::geometry) AS lon,
              ST_Y(location_coordinates::geometry) AS lat
         FROM ci.object_observations WHERE observation_id = $1`,
      [id],
    );

    return row as
      | {
          label: string;
          bbox: unknown;
          attributes: Record<string, unknown>;
          metadata: Record<string, unknown>;
          resolved_object_id: string | null;
          resolution_method: string;
          resolution_confidence: number | null;
          confirmed_by_user: boolean;
          lon: number | null;
          lat: number | null;
        }
      | undefined;
  };

  it('GUARD 1 (triple arbiter) — a re-detection with the same source triple UPDATES the row, never inserts a second one', async () => {
    const contentId = uuidv7();
    const identity = platformIdentity('cv-server', `det-${contentId}`);

    const [first] = (
      await service.createMany(owner, [
        {
          observedAt: new Date('2026-05-01T10:00:00.000Z'),
          label: 'coffee mug',
          contentId,
          sourceType: 'cv_detection',
          sourceSystem: identity.system,
          sourceId: identity.id,
        },
      ])
    ).written;

    await service.createMany(owner, [
      {
        observedAt: new Date('2026-05-01T10:00:05.000Z'),
        label: 'ceramic mug',
        contentId,
        sourceType: 'cv_detection',
        sourceSystem: identity.system,
        sourceId: identity.id,
      },
    ]);

    expect(await countRows(contentId)).toBe(1);
    const row = await rawRow(first.id);
    expect(row?.label).toBe('ceramic mug');
  });

  it('GUARD 1 (detection-key arbiter) — a re-detection with the same content/detector/bbox UPDATES the row, never inserts a second one', async () => {
    const contentId = uuidv7();
    const bbox = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

    const [first] = (
      await service.createMany(owner, [
        {
          observedAt: new Date('2026-05-01T10:00:00.000Z'),
          label: 'coffee mug',
          contentId,
          detector: 'yolov8',
          bbox,
        },
      ])
    ).written;

    await service.createMany(owner, [
      {
        observedAt: new Date('2026-05-01T10:00:05.000Z'),
        label: 'ceramic mug',
        contentId,
        detector: 'yolov8',
        bbox,
      },
    ]);

    expect(await countRows(contentId)).toBe(1);
    const row = await rawRow(first.id);
    expect(row?.label).toBe('ceramic mug');
  });

  it('GUARD 2 (exclusion list) — resolution survives a re-detection on an UNCONFIRMED row, while detection columns refresh', async () => {
    const contentId = uuidv7();
    const bbox = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };

    const [created] = (
      await service.createMany(owner, [
        {
          observedAt: new Date('2026-05-01T10:00:00.000Z'),
          label: 'desk lamp',
          contentId,
          detector: 'yolov8',
          bbox,
        },
      ])
    ).written;

    // A machine resolution — NOT a confirmation. The row stays unconfirmed.
    await service.resolve(owner, created.id, { resolutionMethod: 'label', resolutionConfidence: 0.62 });

    // Re-detection: different label, same arbiter (content + detector + bbox).
    await service.createMany(owner, [
      {
        observedAt: new Date('2026-05-01T10:05:00.000Z'),
        label: 'floor lamp',
        contentId,
        detector: 'yolov8',
        bbox,
      },
    ]);

    const row = await rawRow(created.id);

    // Detection columns DID refresh...
    expect(row?.label).toBe('floor lamp');
    // ...but the resolution reached before the re-detection was not touched —
    // resolved_object_id/resolution_method/resolution_confidence are absent
    // from DO UPDATE SET entirely, independent of the confirmed_by_user guard.
    expect(row?.resolution_method).toBe('label');
    expect(row?.resolution_confidence).toBeCloseTo(0.62, 5);
    expect(row?.confirmed_by_user).toBe(false);
  });

  it('GUARD 3 (confirmation freeze) — a re-detection on a CONFIRMED row changes nothing, not even the detection columns', async () => {
    const contentId = uuidv7();
    const bbox = { x: 0.6, y: 0.1, w: 0.2, h: 0.2 };

    const [created] = (
      await service.createMany(owner, [
        {
          observedAt: new Date('2026-05-01T10:00:00.000Z'),
          label: 'coffee mug',
          contentId,
          detector: 'yolov8',
          bbox,
        },
      ])
    ).written;

    await service.confirm(owner, created.id, true);

    const result = await service.createMany(owner, [
      {
        observedAt: new Date('2026-05-01T10:05:00.000Z'),
        label: 'travel mug',
        contentId,
        detector: 'yolov8',
        bbox,
        detectionConfidence: 0.99,
      },
    ]);

    // Excluded by the WHERE NOT o.confirmed_by_user guard, not written.
    expect(result.written).toHaveLength(0);
    expect(result.protectedByConfirmation).toBe(1);

    const row = await rawRow(created.id);
    // The label a human confirmed survives, byte for byte — a detector
    // re-run does not get to relabel it out from under them.
    expect(row?.label).toBe('coffee mug');
    expect(row?.confirmed_by_user).toBe(true);
  });

  it('GUARD 4 (jsonb merge) — attributes and metadata MERGE across a re-detection instead of replacing', async () => {
    const contentId = uuidv7();
    const bbox = { x: 0.2, y: 0.2, w: 0.1, h: 0.1 };

    const [created] = (
      await service.createMany(owner, [
        {
          observedAt: new Date('2026-05-01T10:00:00.000Z'),
          label: 'coffee mug',
          contentId,
          detector: 'yolov8',
          bbox,
          attributes: { color: 'red' },
          metadata: { reviewer_note: 'looks chipped' },
        },
      ])
    ).written;

    await service.createMany(owner, [
      {
        observedAt: new Date('2026-05-01T10:05:00.000Z'),
        label: 'coffee mug',
        contentId,
        detector: 'yolov8',
        bbox,
        attributes: { count: 2 },
        metadata: { batch: 'nightly-scan' },
      },
    ]);

    const row = await rawRow(created.id);

    // Neither writer's bag clobbered the other's.
    expect(row?.attributes).toEqual({ color: 'red', count: 2 });
    expect(row?.metadata).toEqual({ reviewer_note: 'looks chipped', batch: 'nightly-scan' });
  });

  it('GUARD 5 (ST_MakePoint argument order) — coordinates land as (lon, lat), not transposed', async () => {
    const contentId = uuidv7();
    // London. Distinct enough in both axes that a lon/lat swap cannot pass by
    // coincidence (lat is in-range as a longitude too, near-Greenwich, so this
    // specifically is NOT a case where a transposition would accidentally
    // read back correctly).
    const lat = 51.5074;
    const lon = -0.1278;

    const [created] = (
      await service.createMany(owner, [
        {
          observedAt: new Date('2026-05-01T10:00:00.000Z'),
          label: 'coffee mug',
          contentId,
          coordinates: { lat, lon },
        },
      ])
    ).written;

    const row = await rawRow(created.id);

    expect(row?.lon).toBeCloseTo(lon, 6);
    expect(row?.lat).toBeCloseTo(lat, 6);
  });
});
