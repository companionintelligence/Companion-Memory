import { SlackChannelsTransformService } from '../transform/TransformChannels';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const contentService = {
    search: jest.fn(async () => []),
    create: jest.fn(async () => [{ id: 'content-1' }]),
  };

  const service = new SlackChannelsTransformService(contentService as never, makeLogger() as never);

  return { service, contentService };
}

const connection = { id: 'conn-1' } as never;

function syncJobWithChannels(channels: unknown[]) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { channels } } as never;
}

function channel(id: string) {
  return { id, name: `chan-${id}`, is_private: false, is_im: false, is_mpim: false, num_members: 2 };
}

describe('SlackChannelsTransformService.transform', () => {
  it('keeps going past one channel whose create fails (the dedup unique-violation path)', async () => {
    const { service, contentService } = build();
    contentService.create.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));

    await service.transform({
      connection,
      syncJob: syncJobWithChannels([channel('C111'), channel('C222')]),
    });

    // Both channels were attempted — the first failure did not abort the loop.
    expect(contentService.create).toHaveBeenCalledTimes(2);
  });

  it('scopes the pre-check by type and skips channels that already exist', async () => {
    const { service, contentService } = build();
    contentService.search.mockResolvedValueOnce([{ id: 'content-9' }] as never);

    await service.transform({ connection, syncJob: syncJobWithChannels([channel('C111')]) });

    expect(contentService.search).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { type: 'slack_channel', external_id: 'C111' },
    );
    expect(contentService.create).not.toHaveBeenCalled();
  });
});
