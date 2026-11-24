import type { MailAttachmentOutcome, MailAttachmentRef } from '../../../MailAttachmentService';
import { OutlookMailTransformService } from '../TransformOutlookMail';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

/**
 * See TransformGmail.test: page-level doubles that fan out to the per-row spies
 * the assertions read, and an attachment service double that saves nothing
 * unless a test gives it an `ingest`.
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

  const service = new OutlookMailTransformService(
    communicationService as never,
    {} as never, // ConnectionService — injected but unused by transformOutlookMail
    promoteService as never,
    makeLogger() as never,
    mailAttachments as never,
  );

  return { service, communicationService, promoteService, mailAttachments };
}

const connection = { id: 'conn-1' } as never;

function syncJobWith(messages: unknown[]) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { messages } } as never;
}

function outlookMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'graph-id-1',
    internetMessageId: '<abc@mail.example.com>',
    subject: 'Hello',
    bodyPreview: 'Hi',
    body: { content: 'Hi there', contentType: 'text' },
    from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
    toRecipients: [{ emailAddress: { address: 'kyle@example.com' } }],
    receivedDateTime: '2026-08-18T10:00:00Z',
    ...overrides,
  };
}

describe('OutlookMailTransformService.transformOutlookMail', () => {
  it('stamps the provenance triple, keyed on internetMessageId (stable across folder moves)', async () => {
    const { service, communicationService } = build();

    await service.transformOutlookMail({ connection, syncJob: syncJobWith([outlookMessage()]) });

    expect(communicationService.create).toHaveBeenCalledTimes(1);
    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        connection_id: 'conn-1',
        source_type: 'ETL',
        // Federated email identity, normalized Message-ID —
        // docs/design/cross-pipeline-identity.md.
        source_system: 'email',
        source_id: 'abc@mail.example.com',
      }),
    );
  });

  it('falls back to the Graph id when internetMessageId is missing', async () => {
    const { service, communicationService } = build();

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([outlookMessage({ internetMessageId: undefined })]),
    });

    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        source_system: 'outlook_mail',
        source_id: expect.stringMatching(/^fallback:[0-9a-f]{64}$/),
      }),
    );
  });

  it('leaves source_id unset when the message has no id at all', async () => {
    const { service, communicationService } = build();

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([outlookMessage({ internetMessageId: undefined, id: undefined })]),
    });

    expect(communicationService.create).toHaveBeenCalledTimes(1);
    const [, dto] = communicationService.create.mock.calls[0] as unknown as [unknown, { source_id?: string }];
    expect(dto.source_id).toBeUndefined();
  });

  it('writes Outlook conversationId as thread_id', async () => {
    const { service, communicationService } = build();

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([outlookMessage({ conversationId: 'conv-99' })]),
    });

    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ thread_id: 'conv-99' }),
    );
  });

  it('skips junk and List-Unsubscribe mail under bulk_filtered', async () => {
    const { service, communicationService, promoteService } = build();

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([
        outlookMessage({
          inferenceClassification: 'junk',
          internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:u@bad.example>' }],
        }),
        outlookMessage({
          id: 'graph-id-2',
          internetMessageId: '<promo@shop.example>',
          inferenceClassification: 'other',
          from: { emailAddress: { name: 'Shop', address: 'news@shop.example' } },
          internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:unsub@shop.example>' }],
        }),
      ]),
    });

    expect(communicationService.create).not.toHaveBeenCalled();
    expect(promoteService.processParticipants).not.toHaveBeenCalled();
  });

  it('still skips drafts', async () => {
    const { service, communicationService } = build();

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([outlookMessage({ isDraft: true })]),
    });

    expect(communicationService.create).not.toHaveBeenCalled();
  });
});

describe('OutlookMailTransformService attachments', () => {
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

  /** A message on its own ids, so one page can hold several, with a file attached when asked. */
  const mail = (name: string, withFile: boolean) =>
    outlookMessage({
      id: `graph-${name}`,
      internetMessageId: `<${name}@mail.example.com>`,
      ...(withFile ? { attachments: [{ id: 'file', name: 'report.pdf' }] } : {}),
    });

  it('saves what a message carries and writes the message naming the saved files', async () => {
    const mailAttachments = answering(outcome([REF]));
    const { service, communicationService } = build(mailAttachments);

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([
        outlookMessage({
          attachments: [
            { id: 'file', name: 'report.pdf', '@odata.type': '#microsoft.graph.fileAttachment' },
            { id: 'link', name: 'linked document', '@odata.type': '#microsoft.graph.referenceAttachment' },
          ],
        }),
      ]),
    });

    expect(mailAttachments.ingest).toHaveBeenCalledWith(connection, 'user-1', 'outlook_mail', 'graph-id-1', [
      expect.objectContaining({ id: 'file', unsupported: false }),
      expect.objectContaining({ id: 'link', unsupported: true }),
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

    await service.transformOutlookMail({ connection, syncJob: syncJobWith([outlookMessage()]) });

    expect(mailAttachments.ingest).not.toHaveBeenCalled();
    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ attachments: [] }),
    );
  });

  it('adds the references to a message the page found already imported', async () => {
    const { service, communicationService } = build(answering(outcome([REF])));
    communicationService.createManyDetailed.mockImplementationOnce(async () => [
      // jsonb hands an object back with its keys in its own order, `id` first.
      { entity: { id: 'comm-9', attachments: [{ id: 'content-old', type: 'content' }] }, inserted: false },
    ]);

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([outlookMessage({ attachments: [{ id: 'file' }] })]),
    });

    expect(communicationService.update).toHaveBeenCalledWith({ userId: 'user-1' }, 'comm-9', {
      attachments: [{ id: 'content-old', type: 'content' }, REF],
    });
  });

  it('leaves a message alone that already carries every reference, whatever order jsonb kept its keys in', async () => {
    const { service, communicationService } = build(answering(outcome([REF])));
    communicationService.createManyDetailed.mockImplementationOnce(async () => [
      { entity: { id: 'comm-9', attachments: [{ id: 'content-new', type: 'content' }] }, inserted: false },
    ]);

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([outlookMessage({ attachments: [{ id: 'file' }] })]),
    });

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
            messageId === 'graph-one' ? outcome([], failure) : outcome([REF]),
        ),
      };
      const { service, communicationService } = build(mailAttachments);

      await expect(
        service.transformOutlookMail({
          connection,
          syncJob: syncJobWith([mail('one', true), mail('two', true), mail('three', false)]),
        }),
      ).rejects.toBe(failure);

      // Every message is written, so none is lost. The one whose file failed has no reference to it.
      expect(written(communicationService.create)).toEqual([
        ['one@mail.example.com', []],
        ['two@mail.example.com', [REF]],
        ['three@mail.example.com', []],
      ]);
    });

    it('keeps the references of the files that did save', async () => {
      const failure = new Error('gone');
      const { service, communicationService } = build(answering(outcome([REF], failure)));

      await expect(
        service.transformOutlookMail({ connection, syncJob: syncJobWith([mail('one', true)]) }),
      ).rejects.toBe(failure);

      expect(written(communicationService.create)).toEqual([['one@mail.example.com', [REF]]]);
    });

    it('logs the message it imported without all of its files', async () => {
      const { service } = build(answering(outcome([], new Error('gone'))));
      const logger = (service as unknown as { logger: ReturnType<typeof makeLogger> }).logger;

      await expect(
        service.transformOutlookMail({ connection, syncJob: syncJobWith([mail('one', true)]) }),
      ).rejects.toThrow('gone');

      expect(logger.error).toHaveBeenCalledWith(
        'Importing an Outlook Mail message without all of its attachments',
        expect.objectContaining({ messageId: 'graph-one', saved: 0, unsaved: 1, error: 'gone' }),
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
            if (messageId === 'graph-one') {
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
        .transformOutlookMail({
          connection,
          syncJob: syncJobWith([mail('one', true), mail('two', true)]),
        })
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
        service.transformOutlookMail({ connection, syncJob: syncJobWith([mail('one', true)]) });

      it('gives the stored message the file once it can be saved', async () => {
        const failure = new Error('provider unavailable');
        const { service, communicationService } = build(answers(outcome([], failure), outcome([REF])));
        const rows = table(communicationService);

        await expect(page(service)).rejects.toBe(failure);
        expect(rows.get('one@mail.example.com')?.attachments).toEqual([]);
        expect(communicationService.update).not.toHaveBeenCalled();

        await page(service);
        expect(rows.get('one@mail.example.com')?.attachments).toEqual([
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
        expect(rows.get('one@mail.example.com')?.attachments).toEqual([
          { id: 'content-new', type: 'content' },
        ]);

        await page(service);
        expect(rows.get('one@mail.example.com')?.attachments).toEqual([
          { id: 'content-new', type: 'content' },
          { id: 'content-other', type: 'content' },
        ]);

        await page(service);
        expect(communicationService.update).toHaveBeenCalledTimes(1);
      });
    });
  });
});
