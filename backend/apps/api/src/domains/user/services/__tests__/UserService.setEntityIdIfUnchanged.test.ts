import { UnauthorizedException } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { UserService } from '../UserService';

describe('UserService.setEntityIdIfUnchanged', () => {
  const context = { userId: 'user-1' };

  function makeService(affected: number, currentPointer: string | null = null) {
    const userRepository = {
      update: jest.fn().mockResolvedValue({ affected }),
      findOne: jest.fn().mockResolvedValue({ id: 'user-1', entityId: currentPointer }),
    };
    const eventService = { send: jest.fn() };
    const service = new UserService(userRepository as never, eventService as never);

    return { service, userRepository, eventService };
  }

  it('sets the pointer only while it is still unset, and says so', async () => {
    const { service, userRepository, eventService } = makeService(1);

    await expect(service.setEntityIdIfUnchanged(context, 'user-1', 'mine', null)).resolves.toBe('mine');
    expect(userRepository.update).toHaveBeenCalledWith(
      { id: 'user-1', entityId: IsNull() },
      { entityId: 'mine' },
    );
    expect(eventService.send).toHaveBeenCalledTimes(1);
  });

  it('only replaces the pointer it was told to expect', async () => {
    const { service, userRepository } = makeService(1);

    await service.setEntityIdIfUnchanged(context, 'user-1', 'mine', 'dangling');

    expect(userRepository.update).toHaveBeenCalledWith(
      { id: 'user-1', entityId: 'dangling' },
      { entityId: 'mine' },
    );
  });

  it('leaves a pointer someone else set in the meantime alone and returns it', async () => {
    const { service, eventService } = makeService(0, 'winner');

    await expect(service.setEntityIdIfUnchanged(context, 'user-1', 'mine', null)).resolves.toBe('winner');
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('refuses another account', async () => {
    const { service, userRepository } = makeService(1);

    await expect(
      service.setEntityIdIfUnchanged({ userId: 'user-2' }, 'user-1', 'mine', null),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userRepository.update).not.toHaveBeenCalled();
  });
});
