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

/** Gmail hands body part data back as URL-safe base64. */
function b64url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Headers a receiving MTA stamps at final delivery. Real `format=full` mail
 * carries them; `emailDirection` reads them as the inbound signal.
 */
const DELIVERED = { name: 'Delivered-To', value: 'kyle@example.com' };

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

    const [, input] = communicationService.create.mock.calls[0] as unknown as [
      unknown,
      { thread_id?: string },
    ];
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

describe('GmailTransformService direction', () => {
  it('files a SENT message as OUTBOUND — the sweep SyncGmail explicitly performs', async () => {
    // SyncGmail fetches labelIds=SENT on purpose. The transform used to file
    // every one of those rows 'inbound', which made LifeStatsService read the
    // owner as their own counterparty (then drop it as self) and never count
    // the real recipients.
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({
          id: 'sent-1',
          labelIds: ['SENT'],
          payload: {
            headers: [
              { name: 'Subject', value: 'Re: Hello' },
              { name: 'From', value: 'Kyle <kyle@example.com>' },
              { name: 'To', value: 'alice@example.com' },
              { name: 'Date', value: 'Tue, 18 Aug 2026 11:00:00 -0700' },
              { name: 'Message-ID', value: '<sent-1-rfc@mail.gmail.com>' },
            ],
          },
        }),
      ]),
    });

    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { direction?: string }];
    expect(dto.direction).toBe('outbound');
  });

  it('files delivered mail as INBOUND on the receiving-MTA trace headers', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({
          payload: {
            headers: [
              DELIVERED,
              { name: 'Subject', value: 'Hello' },
              { name: 'From', value: 'Alice <alice@example.com>' },
              { name: 'To', value: 'kyle@example.com' },
              { name: 'Date', value: 'Tue, 18 Aug 2026 10:00:00 -0700' },
              { name: 'Message-ID', value: '<msg-1-rfc@mail.gmail.com>' },
            ],
          },
        }),
      ]),
    });

    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { direction?: string }];
    expect(dto.direction).toBe('inbound');
  });

  it('uses EMAILED, not RECEIVED_EMAIL_FROM, for the From address of an outbound message', async () => {
    // On sent mail the From address is the owner; RECEIVED_EMAIL_FROM would
    // assert the owner received mail from themselves.
    const { service, promoteService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([gmailMessage({ id: 'sent-2', labelIds: ['SENT'] })]),
    });

    const fromCall = promoteService.processParticipants.mock.calls[0] as unknown as unknown[];
    expect(fromCall[4]).toBe('EMAILED');
  });

  it('keeps RECEIVED_EMAIL_FROM for the From address of an inbound message', async () => {
    const { service, promoteService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({
          payload: {
            headers: [
              DELIVERED,
              { name: 'Subject', value: 'Hello' },
              { name: 'From', value: 'Alice <alice@example.com>' },
              { name: 'To', value: 'kyle@example.com' },
              { name: 'Message-ID', value: '<msg-1-rfc@mail.gmail.com>' },
            ],
          },
        }),
      ]),
    });

    const fromCall = promoteService.processParticipants.mock.calls[0] as unknown as unknown[];
    expect(fromCall[4]).toBe('RECEIVED_EMAIL_FROM');
  });
});

describe('GmailTransformService body extraction', () => {
  const NESTED_PLAIN = 'The real body, two MIME levels down and 40+ chars long.';

  /** multipart/mixed → [multipart/alternative → [plain, html], application/pdf] */
  function nestedPayload() {
    return {
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [
        DELIVERED,
        { name: 'Subject', value: 'Quarterly numbers' },
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'kyle@example.com' },
        { name: 'Message-ID', value: '<nested-rfc@mail.gmail.com>' },
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          filename: '',
          parts: [
            { mimeType: 'text/plain; charset="UTF-8"', filename: '', body: { data: b64url(NESTED_PLAIN) } },
            { mimeType: 'text/html', filename: '', body: { data: b64url('<p>markup copy</p>') } },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'numbers.pdf',
          body: { attachmentId: 'att-1', size: 1024 },
        },
      ],
    };
  }

  it('walks a nested multipart tree for the body instead of storing the snippet', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({ id: 'nested-1', snippet: 'The real body, two MIME…', payload: nestedPayload() }),
      ]),
    });

    const [, dto] = communicationService.create.mock.calls[0] as unknown as [
      unknown,
      { content?: string; preview?: string | null },
    ];
    expect(dto.content).toBe(NESTED_PLAIN);
    // The snippet stays a preview and never doubles as the body.
    expect(dto.preview).toBe('The real body, two MIME…');
    expect(dto.content).not.toBe(dto.preview);
  });

  it('flattens a text/html leaf through htmlToText rather than storing raw markup', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({
          id: 'html-1',
          payload: {
            mimeType: 'multipart/alternative',
            filename: '',
            headers: [
              DELIVERED,
              { name: 'Subject', value: 'Rich text' },
              { name: 'From', value: 'Alice <alice@example.com>' },
              { name: 'To', value: 'kyle@example.com' },
              { name: 'Message-ID', value: '<html-1-rfc@mail.gmail.com>' },
            ],
            parts: [
              {
                mimeType: 'text/html',
                filename: '',
                body: {
                  data: b64url('<style>p{color:red}</style><p>Hello&nbsp;Kyle</p><p>Second line</p>'),
                },
              },
            ],
          },
        }),
      ]),
    });

    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { content?: string }];
    expect(dto.content).not.toContain('<p>');
    expect(dto.content).not.toContain('color:red');
    expect(dto.content).toContain('Hello');
    expect(dto.content).toContain('Second line');
  });

  it('prefers a nested text/plain leaf over a top-level text/html one', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({
          id: 'prefer-1',
          payload: {
            mimeType: 'multipart/mixed',
            filename: '',
            headers: [
              DELIVERED,
              { name: 'Subject', value: 'Prefer plain' },
              { name: 'From', value: 'Alice <alice@example.com>' },
              { name: 'To', value: 'kyle@example.com' },
              { name: 'Message-ID', value: '<prefer-1-rfc@mail.gmail.com>' },
            ],
            parts: [
              { mimeType: 'text/html', filename: '', body: { data: b64url('<p>html sibling</p>') } },
              {
                mimeType: 'multipart/related',
                filename: '',
                parts: [{ mimeType: 'text/plain', filename: '', body: { data: b64url('plain wins') } }],
              },
            ],
          },
        }),
      ]),
    });

    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { content?: string }];
    expect(dto.content).toBe('plain wins');
  });

  it('skips an attached .txt file and takes the inline body instead', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({
          id: 'attach-1',
          payload: {
            mimeType: 'multipart/mixed',
            filename: '',
            headers: [
              DELIVERED,
              { name: 'Subject', value: 'With a text attachment' },
              { name: 'From', value: 'Alice <alice@example.com>' },
              { name: 'To', value: 'kyle@example.com' },
              { name: 'Message-ID', value: '<attach-1-rfc@mail.gmail.com>' },
            ],
            parts: [
              { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64url('ATTACHED FILE') } },
              { mimeType: 'text/plain', filename: '', body: { data: b64url('inline body') } },
            ],
          },
        }),
      ]),
    });

    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { content?: string }];
    expect(dto.content).toBe('inline body');
  });

  it('stores an empty content rather than the snippet when the message carries no body part', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([gmailMessage({ snippet: 'a preview, not a body' })]),
    });

    const [, dto] = communicationService.create.mock.calls[0] as unknown as [
      unknown,
      { content?: string; preview?: string | null },
    ];
    expect(dto.content).toBe('');
    expect(dto.preview).toBe('a preview, not a body');
  });

  it('still decodes a single-part payload body', async () => {
    const { service, communicationService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({
          id: 'single-1',
          payload: {
            mimeType: 'text/plain',
            filename: '',
            headers: [
              DELIVERED,
              { name: 'Subject', value: 'Plain single part' },
              { name: 'From', value: 'Alice <alice@example.com>' },
              { name: 'To', value: 'kyle@example.com' },
              { name: 'Message-ID', value: '<single-1-rfc@mail.gmail.com>' },
            ],
            body: { data: b64url('single part body') },
          },
        }),
      ]),
    });

    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { content?: string }];
    expect(dto.content).toBe('single part body');
  });
});
