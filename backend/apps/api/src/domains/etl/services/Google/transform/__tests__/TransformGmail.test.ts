import { emailThreadKey, gmailThreadKeyFromImap } from '@ci/domains/memory';

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
    threadId: '18c1a2b3c4d5e6f7',
    snippet: 'Hi there',
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'Subject', value: 'Hello' },
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'kyle@example.com' },
        { name: 'Date', value: 'Tue, 18 Aug 2026 10:00:00 -0700' },
        { name: 'Message-ID', value: '<msg-1-rfc@mail.gmail.com>' },
      ],
    },
    ...overrides,
  };
}

describe('GmailTransformService.transformGmail', () => {
  it('keys the message on (email, <RFC Message-ID>) so it converges with a Takeout import of the same mail', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({ connection, syncJob: syncJobWith([gmailMessage()]) });

    expect(communicationService.create).toHaveBeenCalledTimes(1);
    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        // The API's hex threadId in the registry's one spelling (see below).
        thread_id: '18c1a2b3c4d5e6f7',
        connection_id: 'conn-1',
        source_type: 'ETL',
        // Federated email identity — docs/design/cross-pipeline-identity.md.
        source_system: 'email',
        source_id: 'msg-1-rfc@mail.gmail.com',
      }),
    );
  });

  it('CONVERGES the thread key with a Takeout mbox of the same message (X-GM-THRID, decimal)', async () => {
    // The API spells the 64-bit thread id in hex; the mbox carries the same
    // number in decimal. Both normalize to one key, so the row a Takeout
    // import writes for this message carries the same thread_id.
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([gmailMessage({ threadId: '18C1A2B3C4D5E6F7' })]),
    });

    const [, input] = communicationService.create.mock.calls[0] as unknown as [unknown, { thread_id?: string }];
    expect(input.thread_id).toBe('18c1a2b3c4d5e6f7');
    expect(input.thread_id).toBe(gmailThreadKeyFromImap('1783885820400625399'));
    expect(input.thread_id).toBe(emailThreadKey({ 'X-GM-THRID': '1783885820400625399' }));
  });

  it('falls back to a gmail-scoped hash id for Message-ID-less mail (stable, never converging)', async () => {
    const { service, communicationService } = build();
    const noMid = gmailMessage();
    (noMid.payload as { headers: { name: string; value: string }[] }).headers = (
      noMid.payload as { headers: { name: string; value: string }[] }
    ).headers.filter((h) => h.name !== 'Message-ID');

    await service.transformGmail({ connection, syncJob: syncJobWith([noMid]) });

    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'gmail',
        source_id: expect.stringMatching(/^fallback:[0-9a-f]{64}$/),
      }),
    );
  });

  it('leaves source_id unset for a message with neither Message-ID nor API id instead of collapsing them onto one row', async () => {
    const { service, communicationService } = build();
    const bare = gmailMessage({ id: undefined });
    (bare.payload as { headers: { name: string; value: string }[] }).headers = (
      bare.payload as { headers: { name: string; value: string }[] }
    ).headers.filter((h) => h.name !== 'Message-ID');

    await service.transformGmail({ connection, syncJob: syncJobWith([bare]) });

    expect(communicationService.create).toHaveBeenCalledTimes(1);
    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { source_id?: string }];
    expect(dto.source_id).toBeUndefined();
  });

  it('skips a newsletter under bulk_filtered and does not create people or a row', async () => {
    const { service, communicationService, promoteService, tagService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({
          id: 'promo-1',
          labelIds: ['CATEGORY_PROMOTIONS', 'INBOX'],
          payload: {
            headers: [
              { name: 'Subject', value: '50% off' },
              { name: 'From', value: 'Shop <news@shop.example>' },
              { name: 'To', value: 'kyle@example.com' },
              { name: 'List-Unsubscribe', value: '<mailto:unsub@shop.example>' },
            ],
          },
        }),
      ]),
    });

    expect(communicationService.create).not.toHaveBeenCalled();
    expect(promoteService.processParticipants).not.toHaveBeenCalled();
    expect(tagService.tagEntities).not.toHaveBeenCalled();
  });

  it('skips a draft under draft', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([gmailMessage({ id: 'draft-1', labelIds: ['DRAFT'] })]),
    });

    expect(communicationService.create).not.toHaveBeenCalled();
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
