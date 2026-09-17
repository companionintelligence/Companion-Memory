import type { UserServiceContext } from '@ci/common/context';

import { PersonService } from './PersonService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const PERSON = '00000000-0000-0000-0000-0000000000b1';
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
  qb.getRawMany = jest.fn(async () => [{ id: PERSON }]);
  qb.getCount = jest.fn(async () => 1);

  const repository = {
    manager: { query },
    createQueryBuilder: jest.fn(() => qb),
  };

  const service = new PersonService(
    repository as never,
    { setContext: jest.fn() } as never,
    { send: jest.fn() } as never,
  );

  return { service, query, qb, repository };
}

describe('PersonService people browse appearance dating', () => {
  it('keeps the unique updated_at list when there is no date window', async () => {
    const { service, query, qb } = makeHarness();

    const rows = await service.getEntitiesForPeople(CONTEXT, { limit: 30 });

    expect(query).not.toHaveBeenCalled();
    expect(qb.orderBy).toHaveBeenCalledWith('person.updated_at', 'DESC');
    expect(rows).toEqual([{ id: PERSON, type: 'person' }]);
  });

  it('joins real activity and returns sortTime when a date window is set', async () => {
    const { service, query, repository } = makeHarness();
    const appearedAt = new Date('2024-03-04T15:00:00Z');
    query.mockResolvedValue([{ id: PERSON, appearedAt }]);

    const rows = await service.getEntitiesForPeople(CONTEXT, {
      startTime: new Date('2024-03-01T00:00:00Z'),
      endTime: new Date('2024-03-31T23:59:59Z'),
      limit: 30,
    });

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("time_source IS DISTINCT FROM 'ingest'");
    expect(sql).toContain('organizer_entity_id');
    expect(rows).toEqual([{ id: PERSON, type: 'person', sortTime: appearedAt }]);
  });

  it('counts by the same appearance join as the list', async () => {
    const { service, query } = makeHarness();
    query.mockResolvedValue([{ n: 4 }]);

    await expect(
      service.countEntitiesForPeople(CONTEXT, { startTime: new Date('2024-03-01T00:00:00Z') }),
    ).resolves.toBe(4);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain("time_source IS DISTINCT FROM 'ingest'");
  });
});
