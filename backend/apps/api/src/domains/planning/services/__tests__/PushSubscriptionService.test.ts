import { PushSubscriptionService } from '../PushSubscriptionService';

const CTX = { userId: 'user-1' } as never;
const DTO = { endpoint: 'https://push.example/abc', p256dh: 'p256dh-key', auth: 'auth-key' };

function makeService(existing: Record<string, unknown> | null = null) {
  const repository = {
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
  };

  return { service: new PushSubscriptionService(repository as never), repository };
}

describe('PushSubscriptionService.subscribe', () => {
  it('registers a new endpoint for the caller', async () => {
    const { service, repository } = makeService(null);

    const subscription = await service.subscribe(CTX, { ...DTO, userAgent: 'Firefox' });

    expect(repository.findOne).toHaveBeenCalledWith({ where: { endpoint: DTO.endpoint } });
    expect(subscription).toEqual(
      expect.objectContaining({ userId: 'user-1', ...DTO, userAgent: 'Firefox', id: expect.any(String) }),
    );
  });

  // Endpoints are globally unique, so re-subscribing one re-points it to the
  // newest subscriber and refreshes its keys instead of inserting a duplicate.
  it('re-points an already-registered endpoint to the caller and refreshes its keys', async () => {
    const existing = {
      id: 'sub-1',
      userId: 'user-2',
      endpoint: DTO.endpoint,
      p256dh: 'old',
      auth: 'old',
      userAgent: 'Chrome',
    };
    const { service, repository } = makeService(existing);

    const subscription = await service.subscribe(CTX, DTO);

    expect(repository.create).not.toHaveBeenCalled();
    expect(subscription).toEqual({
      ...existing,
      userId: 'user-1',
      p256dh: DTO.p256dh,
      auth: DTO.auth,
      userAgent: null,
    });
  });
});

describe('PushSubscriptionService removal and reads', () => {
  it('unsubscribes only the caller’s own endpoint', async () => {
    const { service, repository } = makeService();

    await expect(service.unsubscribe(CTX, DTO.endpoint)).resolves.toBe(true);
    expect(repository.delete).toHaveBeenCalledWith({ endpoint: DTO.endpoint, userId: 'user-1' });
  });

  it('reports false when the caller had no such endpoint', async () => {
    const { service, repository } = makeService();
    repository.delete.mockResolvedValue({ affected: 0 });

    await expect(service.unsubscribe(CTX, DTO.endpoint)).resolves.toBe(false);
  });

  it('lists a user’s subscriptions and removes one by id', async () => {
    const { service, repository } = makeService();

    await service.listForUser('user-1');
    await service.remove('sub-1');

    expect(repository.find).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(repository.delete).toHaveBeenCalledWith({ id: 'sub-1' });
  });
});
