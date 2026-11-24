import { GraphUtilityService } from '../GraphUtilityService';

/**
 * `memory.forget` looks a node up with this before it archives or deletes it.
 * Archive wants only live nodes: one that is already inactive has been forgotten
 * and there is nothing left to do. Delete wants whatever is there, because the
 * first step of "archive, then delete" leaves the node inactive, and a lookup
 * that skips inactive nodes answers "not found" to the second step.
 */
describe('GraphUtilityService.collectEntitySnapshot', () => {
  function makeService(node: object | null) {
    const findOne = jest.fn(async () => node);
    const logger = { setContext: jest.fn() };
    const service = new GraphUtilityService({ findOne } as never, {} as never, logger as never);

    return { service, findOne };
  }

  it('looks up only active nodes by default', async () => {
    const { service, findOne } = makeService({ entity_id: 'e1' });

    await service.collectEntitySnapshot('e1', 'owner-1');

    expect(findOne).toHaveBeenCalledWith({
      where: { entity_id: 'e1', owner_user_id: 'owner-1', is_active: true },
    });
  });

  it('looks up a node whatever its state when asked to include inactive ones', async () => {
    const { service, findOne } = makeService({ entity_id: 'e1' });

    const snapshot = await service.collectEntitySnapshot('e1', 'owner-1', { includeInactive: true });

    expect(findOne).toHaveBeenCalledWith({ where: { entity_id: 'e1', owner_user_id: 'owner-1' } });
    expect(snapshot.node).toEqual({ entity_id: 'e1' });
  });

  it('still scopes the lookup to the owner when including inactive nodes', async () => {
    const { service, findOne } = makeService(null);

    const snapshot = await service.collectEntitySnapshot('e1', 'owner-1', { includeInactive: true });

    expect(findOne.mock.calls[0]).toEqual([{ where: expect.objectContaining({ owner_user_id: 'owner-1' }) }]);
    expect(snapshot).toEqual({ node: null, relationships: [] });
  });
});
