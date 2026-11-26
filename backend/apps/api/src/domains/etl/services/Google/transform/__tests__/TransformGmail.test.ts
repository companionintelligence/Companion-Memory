import { emailThreadKey, gmailThreadKeyFromImap } from '@ci/domains/memory';

import type { MailAttachmentOutcome, MailAttachmentRef } from '../../../MailAttachmentService';
import { GmailTransformService } from '../TransformGmail';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

/**
 * The transform writes a page at a time (one `promoteParticipantGroups`, one
 * `createManyDetailed`), so the doubles fan those out to per-row spies the
 * assertions below read: `create` sees every DTO the page carried, in order,
 * and `processParticipants` sees every group with the same positional
 * arguments the per-message path used to pass.
 *
 * The attachment service double saves nothing unless a test gives it an
 * `ingest`, which is what a message without attachments gets from the real one.
 */
function build(
  mailAttachments = {
    ingest: jest.fn(async (..._args: unknown[]): Promise<MailAttachmentOutcome> => ({
      refs: [],
      failures: [],
    })),
  },
) {
  const create = jest.fn(
    async (_ctx: unknown, _dto: unknown): Promise<{ id: string; attachments?: unknown[] }> => ({
      id: 'comm-1',
    }),
  );
  const communicationService = {
    create,
    update: jest.fn(async (..._args: unknown[]) => ({ id: 'comm-1' })),
    createManyDetailed: jest.fn(
      async (
        ctx: unknown,
        dtos: unknown[],
        _options: unknown,
      ): Promise<Array<{ entity: { id: string; attachments?: unknown[] }; inserted: boolean }>> =>
        await Promise.all(dtos.map(async (dto) => ({ entity: await create(ctx, dto), inserted: true }))),
    ),
  };
  const processParticipants = jest.fn(async (..._args: unknown[]) => ['entity-1']);
  const promoteService = {
    processParticipants,
    promoteParticipantGroups: jest.fn(
      async (
        ctx: { userId: string },
        input: {
          connectionId: string;
          source: string;
          groups: Array<{
            participants: unknown[];
            relationshipType: string;
            startDate?: Date;
            endDate?: Date;
          }>;
        },
      ) =>
        await Promise.all(
          input.groups.map((group) =>
            processParticipants(
              group.participants,
              ctx.userId,
              input.connectionId,
              input.source,
              group.relationshipType,
              group.startDate,
              group.endDate,
            ),
          ),
        ),
    ),
  };
  const tagService = { tagEntities: jest.fn(async () => undefined) };

  const service = new GmailTransformService(
    communicationService as never,
    {} as never, // ConnectionService — injected but unused by transformGmail
    promoteService as never,
    tagService as never,
    makeLogger() as never,
    mailAttachments as never,
  );

  return { service, communicationService, promoteService, tagService, mailAttachments };
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

  it('keeps going past one message it cannot read, and writes the rest of the page', async () => {
    // A re-synced duplicate is no longer an error at all — the page write is
    // an upsert on the identity triple — so the failure that must not cost the
    // page is a message the parser cannot read: headers that are not a list.
    const { service, communicationService, tagService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage({ id: 'broken', payload: { headers: 'not-a-list' } }),
        gmailMessage(),
      ]),
    });

    expect(communicationService.createManyDetailed).toHaveBeenCalledTimes(1);
    expect(communicationService.create).toHaveBeenCalledTimes(1);
    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ source_id: 'msg-1-rfc@mail.gmail.com' }),
    );
    // Only the surviving message gets tagged.
    expect(tagService.tagEntities).toHaveBeenCalledTimes(1);
  });

  it('asks the page write to raise CommunicationCreatedEvent for the rows it inserts', async () => {
    // Nothing else schedules search indexing or people-linking for a
    // connection sync, so the bulk write must emit as create() did.
    const { service, communicationService } = build();

    await service.transformGmail({ connection, syncJob: syncJobWith([gmailMessage()]) });

    expect(communicationService.createManyDetailed).toHaveBeenCalledWith(
      { userId: 'user-1' },
      [expect.objectContaining({ source_id: 'msg-1-rfc@mail.gmail.com' })],
      { emitCreated: true },
    );
  });

  it('resolves every participant of the page in ONE PromoteService call', async () => {
    const { service, promoteService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([gmailMessage(), gmailMessage({ id: 'msg-2' })]),
    });

    expect(promoteService.promoteParticipantGroups).toHaveBeenCalledTimes(1);
    // Four groups per message — from, to, cc, bcc — in message order.
    const [, input] = promoteService.promoteParticipantGroups.mock.calls[0];
    expect(input.groups).toHaveLength(8);
    expect(input.source).toBe('email');
  });

  it('tags once per distinct label set, not once per message', async () => {
    const { service, tagService } = build();

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([
        gmailMessage(),
        gmailMessage({ id: 'msg-2' }),
        gmailMessage({ id: 'msg-3', labelIds: ['INBOX', 'IMPORTANT'] }),
      ]),
    });

    expect(tagService.tagEntities).toHaveBeenCalledTimes(2);
    expect(tagService.tagEntities).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        labels: ['INBOX'],
        entities: [
          { type: 'communication', id: 'comm-1' },
          { type: 'communication', id: 'comm-1' },
        ],
      },
    );
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

describe('GmailTransformService attachments', () => {
  const REF: MailAttachmentRef = { type: 'content', id: 'content-new' };
  const OTHER_REF: MailAttachmentRef = { type: 'content', id: 'content-other' };

  /** What the attachment service answers for one message: the references that saved, then the errors of the rest. */
  const outcome = (refs: MailAttachmentRef[], ...failures: unknown[]): MailAttachmentOutcome => ({
    refs,
    failures,
  });

  /** An attachment service double that gives every message the same answer. */
  const answering = (answer: MailAttachmentOutcome) => ({
    ingest: jest.fn(async (..._args: unknown[]): Promise<MailAttachmentOutcome> => answer),
  });

  /** The messages a page's `create` calls wrote, as their source ids and the attachments they carried. */
  const written = (create: { mock: { calls: unknown[][] } }) =>
    create.mock.calls.map(([, dto]) => {
      const { source_id, attachments } = dto as { source_id?: string; attachments?: unknown[] };

      return [source_id, attachments];
    });

  /** A message on its own Message-ID, so one page can hold several, with a PDF attached when asked. */
  function mail(id: string, withPdf: boolean) {
    const base = gmailMessage({ id });

    return {
      ...base,
      payload: {
        ...base.payload,
        mimeType: 'multipart/mixed',
        headers: [
          ...base.payload.headers.filter((header) => header.name !== 'Message-ID'),
          { name: 'Message-ID', value: `<${id}-rfc@mail.gmail.com>` },
        ],
        parts: [
          { partId: '0', mimeType: 'text/plain', filename: '', body: { data: b64url('see attached') } },
          ...(withPdf
            ? [
                {
                  partId: '1',
                  mimeType: 'application/pdf',
                  filename: 'numbers.pdf',
                  body: { attachmentId: 'att-1', size: 1024 },
                },
              ]
            : []),
        ],
      },
    };
  }

  it('saves what a message carries and writes the message naming the saved files', async () => {
    const mailAttachments = answering(outcome([REF]));
    const { service, communicationService } = build(mailAttachments);

    await service.transformGmail({ connection, syncJob: syncJobWith([mail('msg-1', true)]) });

    expect(mailAttachments.ingest).toHaveBeenCalledWith(connection, 'user-1', 'gmail', 'msg-1', [
      expect.objectContaining({
        id: 'att-1',
        key: '1',
        name: 'numbers.pdf',
        contentType: 'application/pdf',
        size: 1024,
      }),
    ]);
    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ attachments: [REF] }),
    );
    // A row this sync inserted already has them.
    expect(communicationService.update).not.toHaveBeenCalled();
  });

  it('does not ask for attachments of a message that has none', async () => {
    const mailAttachments = answering(outcome([REF]));
    const { service, communicationService } = build(mailAttachments);

    await service.transformGmail({ connection, syncJob: syncJobWith([mail('msg-1', false)]) });

    expect(mailAttachments.ingest).not.toHaveBeenCalled();
    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ attachments: [] }),
    );
  });

  it('does not download the files of a message the sync drops', async () => {
    const mailAttachments = answering(outcome([REF]));
    const { service, communicationService } = build(mailAttachments);

    await service.transformGmail({
      connection,
      syncJob: syncJobWith([{ ...mail('draft-1', true), labelIds: ['DRAFT'] }]),
    });

    expect(mailAttachments.ingest).not.toHaveBeenCalled();
    expect(communicationService.create).not.toHaveBeenCalled();
  });

  it('adds the references to a message the page found already imported', async () => {
    const { service, communicationService } = build(answering(outcome([REF])));
    communicationService.createManyDetailed.mockImplementationOnce(async () => [
      // jsonb hands an object back with its keys in its own order, `id` first.
      { entity: { id: 'comm-9', attachments: [{ id: 'content-old', type: 'content' }] }, inserted: false },
    ]);

    await service.transformGmail({ connection, syncJob: syncJobWith([mail('msg-1', true)]) });

    expect(communicationService.update).toHaveBeenCalledWith({ userId: 'user-1' }, 'comm-9', {
      attachments: [{ id: 'content-old', type: 'content' }, REF],
    });
  });

  it('leaves a message alone that already carries every reference, whatever order jsonb kept its keys in', async () => {
    const { service, communicationService } = build(answering(outcome([REF])));
    communicationService.createManyDetailed.mockImplementationOnce(async () => [
      { entity: { id: 'comm-9', attachments: [{ id: 'content-new', type: 'content' }] }, inserted: false },
    ]);

    await service.transformGmail({ connection, syncJob: syncJobWith([mail('msg-1', true)]) });

    expect(communicationService.update).not.toHaveBeenCalled();
  });

  describe('when an attachment cannot be saved', () => {
    it('writes the message without it, writes the rest of the page, and raises the failure afterwards', async () => {
      const failure = new Error('object store unavailable');
      const mailAttachments = {
        ingest: jest.fn(
          async (
            _connection: unknown,
            _userId: unknown,
            _provider: unknown,
            messageId: unknown,
          ): Promise<MailAttachmentOutcome> =>
            messageId === 'msg-1' ? outcome([], failure) : outcome([REF]),
        ),
      };
      const { service, communicationService, tagService } = build(mailAttachments);

      await expect(
        service.transformGmail({
          connection,
          syncJob: syncJobWith([mail('msg-1', true), mail('msg-2', true), mail('msg-3', false)]),
        }),
      ).rejects.toBe(failure);

      // Every message is written, so none is lost. The one whose file failed has no reference to it.
      expect(written(communicationService.create)).toEqual([
        ['msg-1-rfc@mail.gmail.com', []],
        ['msg-2-rfc@mail.gmail.com', [REF]],
        ['msg-3-rfc@mail.gmail.com', []],
      ]);
      expect(tagService.tagEntities).toHaveBeenCalledTimes(1);
    });

    it('keeps the references of the files that did save', async () => {
      const failure = new Error('gone');
      const { service, communicationService } = build(answering(outcome([REF], failure)));

      await expect(
        service.transformGmail({ connection, syncJob: syncJobWith([mail('msg-1', true)]) }),
      ).rejects.toBe(failure);

      expect(written(communicationService.create)).toEqual([['msg-1-rfc@mail.gmail.com', [REF]]]);
    });

    it('logs the message it imported without all of its files', async () => {
      const { service } = build(answering(outcome([], new Error('gone'))));
      const logger = (service as unknown as { logger: ReturnType<typeof makeLogger> }).logger;

      await expect(
        service.transformGmail({ connection, syncJob: syncJobWith([mail('msg-1', true)]) }),
      ).rejects.toThrow('gone');

      expect(logger.error).toHaveBeenCalledWith(
        'Importing a Gmail message without all of its attachments',
        expect.objectContaining({ messageId: 'msg-1', saved: 0, unsaved: 1, error: 'gone' }),
      );
    });

    it('waits for the attachments of every message before it writes the page, and raises only after', async () => {
      let finishSecond: () => void = () => undefined;
      const mailAttachments = {
        ingest: jest.fn(
          async (
            _connection: unknown,
            _userId: unknown,
            _provider: unknown,
            messageId: unknown,
          ): Promise<MailAttachmentOutcome> => {
            if (messageId === 'msg-1') {
              return outcome([], new Error('object store unavailable'));
            }

            return await new Promise<MailAttachmentOutcome>((resolve) => {
              finishSecond = () => resolve(outcome([REF]));
            });
          },
        ),
      };
      const { service, communicationService } = build(mailAttachments);
      let result = 'running';

      const run = service
        .transformGmail({ connection, syncJob: syncJobWith([mail('msg-1', true), mail('msg-2', true)]) })
        .then(
          () => {
            result = 'saved';
          },
          () => {
            result = 'failed';
          },
        );

      await new Promise((resolve) => setImmediate(resolve));
      expect(result).toBe('running');
      expect(communicationService.create).not.toHaveBeenCalled();

      finishSecond();
      await run;
      expect(result).toBe('failed');
      expect(communicationService.create).toHaveBeenCalledTimes(2);
    });

    describe('and the message is processed again', () => {
      /**
       * A stand-in for the communications table that answers as the upsert does: a
       * source it has seen comes back as stored, with its attachments in jsonb's key
       * order, and `update` rewrites them.
       */
      function table(communicationService: ReturnType<typeof build>['communicationService']) {
        const rows = new Map<string, { id: string; attachments: unknown[] }>();
        const jsonb = (ref: MailAttachmentRef) => ({ id: ref.id, type: ref.type });

        communicationService.createManyDetailed.mockImplementation(async (_context, dtos) =>
          (dtos as Array<{ source_id: string; attachments: MailAttachmentRef[] }>).map((dto) => {
            const stored = rows.get(dto.source_id);

            if (stored) {
              return { entity: stored, inserted: false };
            }

            const row = { id: `comm-${rows.size + 1}`, attachments: dto.attachments.map(jsonb) };
            rows.set(dto.source_id, row);

            return { entity: row, inserted: true };
          }),
        );
        communicationService.update.mockImplementation(async (...args: unknown[]) => {
          const [, id, data] = args as [unknown, string, { attachments: MailAttachmentRef[] }];
          const row = [...rows.values()].find((candidate) => candidate.id === id);

          if (row) {
            row.attachments = data.attachments.map(jsonb);
          }

          return { id };
        });

        return rows;
      }

      /** An attachment service double that gives each run the next answer. */
      const answers = (...runs: MailAttachmentOutcome[]) => ({
        ingest: jest.fn(async (..._args: unknown[]): Promise<MailAttachmentOutcome> => runs.shift()!),
      });
      const page = (service: ReturnType<typeof build>['service']) =>
        service.transformGmail({ connection, syncJob: syncJobWith([mail('msg-1', true)]) });

      it('gives the stored message the file once it can be saved', async () => {
        const failure = new Error('provider unavailable');
        const { service, communicationService } = build(answers(outcome([], failure), outcome([REF])));
        const rows = table(communicationService);

        await expect(page(service)).rejects.toBe(failure);
        expect(rows.get('msg-1-rfc@mail.gmail.com')?.attachments).toEqual([]);
        expect(communicationService.update).not.toHaveBeenCalled();

        await page(service);
        expect(rows.get('msg-1-rfc@mail.gmail.com')?.attachments).toEqual([
          { id: 'content-new', type: 'content' },
        ]);
        expect(communicationService.update).toHaveBeenCalledTimes(1);
        expect(rows.size).toBe(1);
      });

      it('adds only the file that was missing, and nothing more on a third run', async () => {
        const failure = new Error('provider unavailable');
        const { service, communicationService } = build(
          answers(outcome([REF], failure), outcome([REF, OTHER_REF]), outcome([REF, OTHER_REF])),
        );
        const rows = table(communicationService);

        await expect(page(service)).rejects.toBe(failure);
        expect(rows.get('msg-1-rfc@mail.gmail.com')?.attachments).toEqual([
          { id: 'content-new', type: 'content' },
        ]);

        await page(service);
        expect(rows.get('msg-1-rfc@mail.gmail.com')?.attachments).toEqual([
          { id: 'content-new', type: 'content' },
          { id: 'content-other', type: 'content' },
        ]);

        await page(service);
        expect(communicationService.update).toHaveBeenCalledTimes(1);
      });
    });
  });
});
