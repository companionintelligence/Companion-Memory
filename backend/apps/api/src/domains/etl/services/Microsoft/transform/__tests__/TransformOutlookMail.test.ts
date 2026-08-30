import { OutlookMailTransformService } from '../TransformOutlookMail';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const communicationService = { create: jest.fn(async () => ({ id: 'comm-1' })) };
  const promoteService = { processParticipants: jest.fn(async () => ['entity-1']) };

  const service = new OutlookMailTransformService(
    communicationService as never,
    {} as never, // ConnectionService — injected but unused by transformOutlookMail
    promoteService as never,
    makeLogger() as never,
  );

  return { service, communicationService, promoteService };
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
        source_system: 'outlook_mail',
        source_id: '<abc@mail.example.com>',
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
      expect.objectContaining({ source_id: 'graph-id-1' }),
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

  it('still skips drafts', async () => {
    const { service, communicationService } = build();

    await service.transformOutlookMail({
      connection,
      syncJob: syncJobWith([outlookMessage({ isDraft: true })]),
    });

    expect(communicationService.create).not.toHaveBeenCalled();
  });
});
