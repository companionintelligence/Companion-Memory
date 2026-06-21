import { GraphUtilityService } from '../GraphUtilityService';

/** Minimal chainable query-builder mock that records every call and returns a
 * configurable `getRawMany` result. */
function makeQueryBuilder(rawMany: Array<{ entity_id: string }>) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => {
    calls[name] ??= [];

    return (...args: unknown[]) => {
      calls[name].push(args);

      return qb;
    };
  };

  const qb = {
    select: record('select'),
    where: record('where'),
    andWhere: record('andWhere'),
    limit: record('limit'),
    getRawMany: jest.fn(async () => rawMany),
    calls,
  };

  return qb;
}

describe('GraphUtilityService.getEntityIdsByLinkedOrEntityIds', () => {
  function setup(rawMany: Array<{ entity_id: string }>) {
    const qb = makeQueryBuilder(rawMany);
    const entityRepo = { createQueryBuilder: jest.fn(() => qb) };
    const logger = { setContext: jest.fn() };

    const service = new GraphUtilityService(entityRepo as never, {} as never, logger as never);

    return { service, qb, entityRepo };
  }

  it('short-circuits without querying for an empty id set', async () => {
    const { service, entityRepo } = setup([]);

    const result = await service.getEntityIdsByLinkedOrEntityIds('user-1', []);

    expect(result).toEqual([]);
    expect(entityRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('matches entity_id OR linked_id and maps rows to entity_ids', async () => {
    const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
    const { service, qb } = setup([{ entity_id: 'node-a' }, { entity_id: 'node-b' }]);

    const result = await service.getEntityIdsByLinkedOrEntityIds('user-1', ids);

    expect(result).toEqual(['node-a', 'node-b']);

    const orPredicate = qb.calls.andWhere.find(
      ([clause]: unknown[]) =>
        typeof clause === 'string' &&
        clause.includes('entity.entity_id IN (:...ids)') &&
        clause.includes('entity.linked_id IN (:...ids)'),
    );

    expect(orPredicate).toBeDefined();
    expect(orPredicate?.[1]).toEqual({ ids });
  });
});
