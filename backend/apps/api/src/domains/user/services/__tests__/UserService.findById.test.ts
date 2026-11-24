import { SYSTEM_USER } from '@ci/common/context';

import { UserService } from '../UserService';

/**
 * TypeORM leaves an `undefined` where-value out of the SQL it builds, so `findOne({ where: { id } })`
 * with no id is a query with no filter, and it answers with the first account in `ci.users`. A
 * caller holding a token with no `sub` once got exactly that, an arbitrary account. No id has to
 * name no account.
 */
describe('UserService.findById', () => {
  function makeService() {
    const userRepository = { findOne: jest.fn().mockResolvedValue({ id: 'first-row' }) };
    const service = new UserService(userRepository as never, { send: jest.fn() } as never);

    return { service, userRepository };
  }

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number', 42],
  ])('finds nobody, without querying, for %s', async (_label, id) => {
    const { service, userRepository } = makeService();

    await expect(service.findById({ userId: SYSTEM_USER }, id as never)).resolves.toBeNull();
    expect(userRepository.findOne).not.toHaveBeenCalled();
  });

  it('looks up a real id', async () => {
    const { service, userRepository } = makeService();
    userRepository.findOne.mockResolvedValue(null);

    await expect(service.findById({ userId: SYSTEM_USER }, 'user-1')).resolves.toBeNull();
    expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 'user-1' } });
  });
});
