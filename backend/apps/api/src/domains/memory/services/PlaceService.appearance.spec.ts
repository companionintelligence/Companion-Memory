import type { UserServiceContext } from '@ci/common/context';

import { EVENT_HAPPENED_SQL } from './eventHappened';
import { PlaceService } from './PlaceService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const PLACE = '00000000-0000-0000-0000-0000000000c1';
const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeHarness() {
  const query = jest.fn();
  const qb: Record<string, unknown> = {};
  qb.select = jest.fn(() => qb);
  qb.where = jest.fn(() => qb);
  qb.andWhere = jest.fn(() => qb);
  qb.orderBy = jest.fn(() => qb);
  qb.addOrderBy = jest.fn(() => qb);
  qb.limit = jest.fn(() => qb);
  qb.getRawMany = jest.fn(async () => [{ id: PLACE }]);
  qb.getCount = jest.fn(async () => 1);

  const repository = {
    manager: { query },
    createQueryBuilder: jest.fn(() => qb),
  };

  const service = new PlaceService(
    repository as never,
    { send: jest.fn() } as never,
    {
      entityCreated: jest.fn(),
      entityUpdated: jest.fn(),
      entityDeleted: jest.fn(),
      recordMany: jest.fn(),
    } as never,
  );

  return { service, query, qb, repository };
}

describe('PlaceService places browse appearance dating', () => {
  it('keeps the unique updated_at list when there is no date window', async () => {
    const { service, query, qb } = makeHarness();

    const rows = await service.getEntitiesForPlaces(CONTEXT, { limit: 30 });

    expect(query).not.toHaveBeenCalled();
    expect(qb.orderBy).toHaveBeenCalledWith('place.updated_at', 'DESC');
    expect(rows).toEqual([{ id: PLACE, type: 'place' }]);
  });

  it('joins visits and returns sortTime when a date window is set', async () => {
    const { service, query, repository } = makeHarness();
    const appearedAt = new Date('2024-07-12T09:00:00Z');
    query.mockResolvedValue([{ id: PLACE, appearedAt }]);

    const rows = await service.getEntitiesForPlaces(CONTEXT, {
      startTime: new Date('2024-07-01T00:00:00Z'),
      endTime: new Date('2024-07-31T23:59:59Z'),
      limit: 30,
    });

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('location_entity_id');
    expect(sql).toContain("time_source IS DISTINCT FROM 'ingest'");
    expect(sql).toContain(EVENT_HAPPENED_SQL);
    expect(sql).not.toContain('communications');
    expect(rows).toEqual([{ id: PLACE, type: 'place', sortTime: appearedAt }]);
  });
});
