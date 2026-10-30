import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { DeviceEntity, type DeviceService } from '@ci/domains/devices';
import type { EventService } from '@ci/domains/events';
import { GraphNodeEntity } from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PositionEntity } from '../../entities/PositionEntity';
import { PositionService } from '../PositionService';

/**
 * A position fix that names another account's device or place is refused, in Postgres.
 *
 * The keys on `device_id`, `location_entity_id` and `reference_entity_id` only
 * ask that the row exists, so `/v1/positions` stored a fix at another
 * account's place or from another account's phone. The device lookup before the
 * insert only logged a warning. An import of the account's own export then
 * refused to restore the fix.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[position/PositionService.foreignLinks.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const refused = (field: string, id: string, table: string) =>
  `${field} ${id} is a row of ${table} that belongs to another account or to none, so the position was refused.`;

describeWithDb(
  `PositionService links to another account's rows, in Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let service: PositionService;

    const ownerId = uuidv7();
    const otherId = uuidv7();
    const owner = { userId: ownerId } as UserServiceContext;

    const myPlace = uuidv7();
    const theirPlace = uuidv7();
    const theirDevice = uuidv7();

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        ...dataSourceConnection(DATABASE_ENV),
        entities: [PositionEntity, UserEntity, DeviceEntity, GraphNodeEntity],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });
      await dataSource.initialize();
      schemaLock = await acquireSchemaWriteLock(dataSource, 'position/PositionService.foreignLinks');

      for (const userId of [ownerId, otherId]) {
        await createSyntheticTestUser(
          (sql, params) => dataSource.query(sql, params),
          'PositionLinks',
          userId,
        );
      }

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name)
       VALUES ($1, 'Location', $2, 'My home'), ($3, 'Location', $4, 'Their home')`,
        [myPlace, ownerId, theirPlace, otherId],
      );
      await dataSource.query(
        `INSERT INTO ci.devices (device_id, user_id, device_name, device_type) VALUES ($1, $2, 'Their phone', 'phone')`,
        [theirDevice, otherId],
      );

      service = new PositionService(
        dataSource.getRepository(PositionEntity),
        { findById: jest.fn(async () => null) } as unknown as DeviceService,
        { send: jest.fn(async () => undefined) } as unknown as EventService,
        {
          setContext: jest.fn(),
          log: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        } as unknown as LoggerService,
      );
    });

    afterEach(async () => {
      await dataSource.query('DELETE FROM ci.position WHERE user_id = $1', [ownerId]);
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        const users = [ownerId, otherId];

        await dataSource.query('DELETE FROM ci.position WHERE user_id = ANY($1::uuid[])', [users]);
        await dataSource.query('DELETE FROM ci.devices WHERE user_id = ANY($1::uuid[])', [users]);
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
        await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [users]);
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    const stored = async (): Promise<number> =>
      Number(
        (await dataSource.query('SELECT count(*) AS n FROM ci.position WHERE user_id = $1', [ownerId]))[0].n,
      );

    const fix = (time: string, link: Record<string, unknown> = {}) => ({
      time,
      source: 'gps' as const,
      location: { x: -122.42, y: 37.77 },
      ...link,
    });

    it("refuses a batch with a fix at another account's place, and takes one at the account's own", async () => {
      await expect(
        service.create(owner, [
          fix('2026-10-20T09:00:00Z', { location_entity_id: myPlace }),
          fix('2026-10-20T09:01:00Z', { location_entity_id: theirPlace }),
        ]),
      ).rejects.toThrow(refused('location_entity_id', theirPlace, 'ci.entities'));
      expect(await stored()).toBe(0);

      const [mine] = await service.create(owner, [
        fix('2026-10-20T09:00:00Z', { location_entity_id: myPlace }),
      ]);

      expect(mine.locationEntityId).toBe(myPlace);
    });

    it("refuses a fix from another account's device", async () => {
      await expect(
        service.create(owner, [fix('2026-10-20T10:00:00Z', { device_id: theirDevice })]),
      ).rejects.toThrow(refused('device_id', theirDevice, 'ci.devices'));
      expect(await stored()).toBe(0);
    });

    it("refuses a fix placed relative to another account's place", async () => {
      await expect(
        service.create(owner, [
          {
            time: '2026-10-20T11:00:00Z',
            source: 'manual' as const,
            reference_entity_id: theirPlace,
            relative_coordinates: { x: 1, y: 2 },
          },
        ]),
      ).rejects.toThrow(refused('reference_entity_id', theirPlace, 'ci.entities'));
      expect(await stored()).toBe(0);
    });
  },
);
