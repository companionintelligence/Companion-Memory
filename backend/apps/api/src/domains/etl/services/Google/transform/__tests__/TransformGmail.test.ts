import { GmailTransformService } from '../TransformGmail';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const communicationService = { create: jest.fn(async () => ({ id: 'comm-1' })) };
  const promoteService = { processParticipants: jest.fn(async () => ['entity-1']) };
  const tagService = { tagEntities: jest.fn(async () => undefined) };

  const service = new GmailTransformService(
    communicationService as never,
    {} as never, // ConnectionService — injected but unused by transformGmail
    promoteService as never,
    tagService as never,
    makeLogger() as never,
  );

  return { service, communicationService, promoteService, tagService };
}

const connection = { id: 'conn-1' } as never;

function syncJobWith(messages: unknown[]) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { messages } } as never;
}

function gmailMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    snippet: 'Hi there',
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'Subject', value: 'Hello' },
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'kyle@example.com' },
        { name: 'Date', value: 'Tue, 18 Aug 2026 10:00:00 -0700' },
      ],
    },
    ...overrides,
  };
}

describe('GmailTransformService.transformGmail', () => {
  it('stamps the provenance triple so a re-synced message dedupes on communications_source_triple_uniq', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({ connection, syncJob: syncJobWith([gmailMessage()]) });

    expect(communicationService.create).toHaveBeenCalledTimes(1);
    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        thread_id: 'thread-1',
        connection_id: 'conn-1',
        source_type: 'ETL',
        source_system: 'gmail',
        source_id: 'msg-1',
      }),
    );
  });

  it('leaves source_id unset for a message without an id instead of collapsing them onto one row', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({ connection, syncJob: syncJobWith([gmailMessage({ id: undefined })]) });

    expect(communicationService.create).toHaveBeenCalledTimes(1);
    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { source_id?: string }];
    expect(dto.source_id).toBeUndefined();
  });

  it('keeps going past one message whose create fails (the dedup unique-violation path)', async () => {
    const { service, communicationService, tagService } = build();
    communicationService.create.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint'),
    );

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([gmailMessage(), gmailMessage({ id: 'msg-2' })]),
    });

    expect(communicationService.create).toHaveBeenCalledTimes(2);
    // Only the surviving message gets tagged.
    expect(tagService.tagEntities).toHaveBeenCalledTimes(1);
  });
});
