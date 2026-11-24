import type { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { DeviceService } from '@ci/domains/devices';
import type { EventService } from '@ci/domains/events';

import type { PositionEntity } from '../../entities/PositionEntity';
import { PositionService } from '../PositionService';

const ctx = { userId: '00000000-0000-0000-0000-0000000000aa' } as UserServiceContext;
const POSITION_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

/** One row as `SELECT *, ST_AsGeoJSON(location)::json AS location_geojson` hands it back. */
const row = {
  id: POSITION_ID,
  time: new Date('2026-10-14T09:00:00.000Z'),
  user_id: ctx.userId,
  // What node-postgres returns for a geography column read by a raw query.
  location: '0101000020E6100000000000000000E03F000000000000E03F',
  location_geojson: { type: 'Point', coordinates: [0.5, 0.5] },
  source: 'gps',
  relative_coordinates: {},
  relative_orientation: {},
  is_private: false,
};

function makeService() {
  const query = jest.fn(async () => [row]);
  const repository = { query } as unknown as Repository<PositionEntity>;
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as LoggerService;
  const service = new PositionService(
    repository,
    {} as unknown as DeviceService,
    {} as unknown as EventService,
    logger,
  );

  return { service, query };
}

describe('PositionService.findByGeofence', () => {
  it('returns each fix with its id and its location', async () => {
    const { service } = makeService();

    const [position] = await service.findByGeofence(ctx, {
      center: { longitude: 0.5, latitude: 0.5 },
      radius_meters: 100,
    });

    expect(position.id).toBe(POSITION_ID);
    expect(position.location).toEqual({ type: 'Point', coordinates: [0.5, 0.5] });
  });

  it('filters a polygon with ST_Covers, which has a geography overload', async () => {
    const { service, query } = makeService();

    await service.findByGeofence(ctx, {
      coordinates: [
        { longitude: 0, latitude: 0 },
        { longitude: 1, latitude: 0 },
        { longitude: 1, latitude: 1 },
      ],
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];

    expect(sql).toContain('ST_Covers(');
    expect(sql).not.toContain('ST_Within(');
    expect(params).toEqual([ctx.userId, 'SRID=4326;POLYGON((0 0, 1 0, 1 1, 0 0))']);
  });
});
