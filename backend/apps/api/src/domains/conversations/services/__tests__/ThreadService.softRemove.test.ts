import { ThreadService } from '../ThreadService';

function build(affected: number) {
  const repository = { update: jest.fn(async () => ({ affected })) };
  const messageService = { findByThreadId: jest.fn(async () => []), softRemove: jest.fn(async () => true) };
  const eventService = { send: jest.fn(async () => []) };
  const eventEmitter = { emit: jest.fn() };
  const service = new ThreadService(
    repository as never,
    messageService as never,
    eventService as never,
    eventEmitter as never,
  );

  return { service, repository, eventEmitter };
}

/**
 * Deleting a chat while it answers archives the thread and stops the turn. The stopped turn's own `idle` write goes
 * through `update`, which skips archived threads, so the delete has to clear the status itself: a thread left
 * `running` read as someone waiting on the model and held every background model queue for 15 minutes.
 */
describe('ThreadService.softRemove', () => {
  it('archives the thread and sets its generation status back to idle in one write', async () => {
    const { service, repository, eventEmitter } = build(1);

    await expect(service.softRemove({ userId: 'user-1' } as never, 'thread-1')).resolves.toBe(true);

    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(repository.update).toHaveBeenCalledWith(
      { id: 'thread-1', user: { id: 'user-1' } },
      { isArchived: true, generationStatus: 'idle' },
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith(expect.anything(), { threadId: 'thread-1' });
  });

  it('reports a thread it could not find', async () => {
    const { service, eventEmitter } = build(0);

    await expect(service.softRemove({ userId: 'user-1' } as never, 'thread-1')).resolves.toBe(false);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
