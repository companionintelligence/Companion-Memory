import {
  MailAttachmentService,
  gmailAttachments,
  withAttachmentRefs,
  MAX_MAIL_ATTACHMENT_BYTES,
} from '../MailAttachmentService';

const connection = { id: 'connection', providerId: 'provider' } as never;

/** The stored connection a download renews first: what the orchestrator handed over, or what a sync saved since. */
type StoredConnection = {
  id: string;
  providerId: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: Date;
};

function harness(existing: Record<string, unknown> | null = null, stored: StoredConnection | null = null) {
  const request = jest.fn(async (_connection: unknown, _path: string, _options?: unknown) => ({
    data: Buffer.from('pdf bytes').toString('base64url'),
  }));
  const requestRaw = jest.fn(
    async (_connection: unknown, _path: string, _options?: unknown) =>
      new Response('pdf bytes', { headers: { 'content-type': 'application/pdf' } }),
  );
  const files = { upload: jest.fn(async (_context: unknown, _dto: unknown) => ({ id: 'file-1' })) };
  const content = {
    findBySource: jest.fn(async (_context: unknown, _source: unknown) => existing),
    create: jest.fn(async (_context: unknown, _dto: Record<string, unknown>) => [{ id: 'content-1' }]),
    update: jest.fn(),
  };
  const refreshAccessToken = jest.fn(
    async (
      _connection: unknown,
    ): Promise<{ accessToken: string | null; refreshToken: string | null; tokenExpiry: Date | null }> => ({
      accessToken: 'renewed-token',
      refreshToken: null,
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    }),
  );
  // Without a stored connection the one handed to `ingest` is used as it is.
  let current = stored;
  const connections = {
    findById: jest.fn(async (_context: unknown, _id: string) => current),
    update: jest.fn(async (_context: unknown, _id: string, data: Record<string, unknown>) => {
      current = { ...current, ...data } as StoredConnection;

      return current;
    }),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const getClientByProviderId = jest.fn(() => ({ request, requestRaw, refreshAccessToken }));
  const service = new MailAttachmentService(
    { getClientByProviderId } as never,
    files as never,
    content as never,
    connections as never,
    logger as never,
  );

  return {
    service,
    request,
    requestRaw,
    refreshAccessToken,
    getClientByProviderId,
    connections,
    files,
    content,
    logger,
  };
}

describe('mail attachment ingestion', () => {
  it('finds nested MIME attachments while leaving ordinary message-body leaves alone', () => {
    expect(
      gmailAttachments({
        parts: [
          { mimeType: 'text/plain', body: { data: 'body' } },
          {
            parts: [
              {
                partId: '2.1',
                filename: 'report.pdf',
                mimeType: 'application/pdf',
                body: { attachmentId: 'remote', size: 9 },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: 'remote',
        key: '2.1',
        name: 'report.pdf',
        contentType: 'application/pdf',
        size: 9,
        data: undefined,
        unsupported: false,
      },
    ]);
  });

  it('names an attachment that is the whole message by its path, since Gmail gives that part no partId', () => {
    expect(
      gmailAttachments({
        partId: '',
        filename: 'scan.pdf',
        mimeType: 'application/pdf',
        body: { attachmentId: 'remote', size: 9 },
      }),
    ).toEqual([expect.objectContaining({ id: 'remote', key: '0' })]);
  });

  it('retains nested Gmail containers without bytes as unsupported metadata rather than inventing a download id', () => {
    expect(
      gmailAttachments({ partId: '1', filename: 'forwarded.eml', mimeType: 'message/rfc822', parts: [] }),
    ).toEqual([expect.objectContaining({ id: '1', unsupported: true })]);
  });

  it('downloads Gmail bytes with the authenticated provider and stores a locally resolvable content file', async () => {
    const { service, request, files, content } = harness();
    expect(
      await service.ingest(connection, 'owner', 'gmail', 'message/id', [
        { id: 'att/id', name: '../report.pdf', contentType: 'application/pdf' },
      ]),
    ).toEqual({ refs: [{ type: 'content', id: 'content-1' }], failures: [] });
    expect(request).toHaveBeenCalledWith(
      connection,
      '/gmail/v1/users/me/messages/message%2Fid/attachments/att%2Fid',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(files.upload).toHaveBeenCalledWith(
      { userId: 'owner' },
      expect.objectContaining({ filename: 'report.pdf', buffer: Buffer.from('pdf bytes'), size: 9 }),
    );
    expect(content.create).toHaveBeenCalledWith(
      { userId: 'owner' },
      expect.objectContaining({
        external_id: 'file-1',
        external_id_kind: 'file',
        connection_id: 'connection',
        source_data: expect.objectContaining({ ingestion_status: 'stored' }),
      }),
    );
  });

  it('uses inline Gmail attachment data without another provider request', async () => {
    const { service, request, files } = harness();
    await service.ingest(connection, 'owner', 'gmail', 'message', [
      { id: 'inline', data: Buffer.from('photo').toString('base64url') },
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(files.upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ buffer: Buffer.from('photo') }),
    );
  });

  it('downloads Outlook file bytes from the attachment value endpoint', async () => {
    const { service, requestRaw, files } = harness();
    await service.ingest(connection, 'owner', 'outlook_mail', 'message', [{ id: 'att', name: 'report.pdf' }]);
    expect(requestRaw).toHaveBeenCalledWith(
      connection,
      '/v1.0/me/messages/message/attachments/att/$value',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(files.upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ buffer: Buffer.from('pdf bytes') }),
    );
  });

  it('reuses catalogued bytes on retries without fetching or uploading again', async () => {
    const { service, request, files, content } = harness({
      id: 'old-content',
      externalIdKind: 'file',
      externalId: 'old-file',
    });
    expect(await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'att' }])).toEqual({
      refs: [{ type: 'content', id: 'old-content' }],
      failures: [],
    });
    expect(request).not.toHaveBeenCalled();
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).not.toHaveBeenCalled();
  });

  it('keeps equal provider ids in different connected mailboxes separate', async () => {
    const { service, content } = harness();
    await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'att' }]);
    await service.ingest(
      { id: 'other-mailbox', providerId: 'provider' } as never,
      'owner',
      'gmail',
      'message',
      [{ id: 'att' }],
    );
    expect(content.findBySource.mock.calls[0][1]).not.toEqual(content.findBySource.mock.calls[1][1]);
  });

  it('retains unsupported Outlook links as metadata without downloading arbitrary content', async () => {
    const { service, requestRaw, files, content } = harness();
    await service.ingest(connection, 'owner', 'outlook_mail', 'message', [{ id: 'att', unsupported: true }]);
    expect(requestRaw).not.toHaveBeenCalled();
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source_data: expect.objectContaining({ ingestion_status: 'unsupported_attachment_type' }),
      }),
    );
  });

  it('upgrades a metadata-only record when bytes become available on retry', async () => {
    const { service, content } = harness({ id: 'old-content', externalIdKind: null, externalId: null });
    expect(await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'att' }])).toEqual({
      refs: [{ type: 'content', id: 'old-content' }],
      failures: [],
    });
    expect(content.update).toHaveBeenCalledWith(
      { userId: 'owner' },
      'old-content',
      expect.objectContaining({ external_id: 'file-1', external_id_kind: 'file' }),
    );
    expect(content.create).not.toHaveBeenCalled();
  });

  it('retains an explicit metadata record for oversized files without claiming bytes exist', async () => {
    const { service, request, files, content } = harness();
    await service.ingest(connection, 'owner', 'gmail', 'message', [
      { id: 'att', size: MAX_MAIL_ATTACHMENT_BYTES + 1 },
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source_data: expect.objectContaining({ ingestion_status: 'too_large' }) }),
    );
    expect(content.create.mock.calls[0][1]).not.toHaveProperty('external_id');
  });

  it('reports a failed download instead of throwing, so the message can still be written without it', async () => {
    const { service, request, files, content, logger } = harness();
    request.mockRejectedValue(new Error('provider unavailable'));
    expect(await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'att' }])).toEqual({
      refs: [],
      failures: [new Error('provider unavailable')],
    });
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Mail attachment could not be saved',
      expect.objectContaining({
        provider: 'gmail',
        messageId: 'message',
        attachmentId: 'att',
        error: 'provider unavailable',
      }),
    );
  });

  it('tries every attachment of a message, so one that fails does not keep the others from being saved', async () => {
    const { service, request, files } = harness();
    request
      .mockRejectedValueOnce(new Error('first is gone'))
      .mockResolvedValueOnce({ data: Buffer.from('pdf bytes').toString('base64url') })
      .mockRejectedValueOnce(new Error('third is gone'));
    const outcome = await service.ingest(connection, 'owner', 'gmail', 'message', [
      { id: 'first' },
      { id: 'second' },
      { id: 'third' },
    ]);
    expect(outcome.refs).toEqual([{ type: 'content', id: 'content-1' }]);
    expect(outcome.failures.map((failure) => (failure as Error).message)).toEqual([
      'first is gone',
      'third is gone',
    ]);
    expect(files.upload).toHaveBeenCalledTimes(1);
  });

  it('does not reject when it cannot even reach the provider client', async () => {
    const { service, getClientByProviderId, files } = harness();
    getClientByProviderId.mockImplementationOnce(() => {
      throw new Error('Unsupported Provider id: provider');
    });
    const outcome = await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'att' }]);
    expect(outcome.refs).toEqual([]);
    expect(outcome.failures).toEqual([new Error('Unsupported Provider id: provider')]);
    expect(files.upload).not.toHaveBeenCalled();
  });

  it('names a Gmail attachment by its position in the message, which a new attachment id does not change', async () => {
    const { service, content } = harness();
    await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'first-fetch', key: '1' }]);
    await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'second-fetch', key: '1' }]);
    await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'second-fetch', key: '2' }]);
    const looked = content.findBySource.mock.calls.map(([, source]) => source);
    expect(looked[0]).toEqual(looked[1]);
    expect(looked[0]).not.toEqual(looked[2]);
  });

  it('keeps a record without bytes when Gmail sends more encoded data than the limit allows', async () => {
    const { service, request, files, content } = harness();
    request.mockResolvedValueOnce({ data: 'A'.repeat(Math.ceil(MAX_MAIL_ATTACHMENT_BYTES / 3) * 4 + 8) });
    await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'att' }]);
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source_data: expect.objectContaining({ ingestion_status: 'too_large' }) }),
    );
  });

  it('refuses Gmail data that is not base64', async () => {
    const { service, request, files, content } = harness();
    request.mockResolvedValueOnce({ data: 'not base64 ***' });
    expect(await service.ingest(connection, 'owner', 'gmail', 'message', [{ id: 'att' }])).toEqual({
      refs: [],
      failures: [new Error('Mail attachment has invalid encoded bytes')],
    });
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).not.toHaveBeenCalled();
  });

  it('keeps a record without bytes when an Outlook file declares more than the limit, and does not read it', async () => {
    const { service, requestRaw, files, content } = harness();
    const response = new Response('x', {
      headers: { 'content-length': String(MAX_MAIL_ATTACHMENT_BYTES + 1) },
    });
    const cancel = jest.spyOn(response.body!, 'cancel');
    requestRaw.mockResolvedValueOnce(response);
    await service.ingest(connection, 'owner', 'outlook_mail', 'message', [{ id: 'att' }]);
    expect(cancel).toHaveBeenCalled();
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source_data: expect.objectContaining({ ingestion_status: 'too_large' }) }),
    );
    expect(content.create.mock.calls[0][1]).not.toHaveProperty('external_id');
  });

  it('stops reading an Outlook file once it passes the limit when no length was declared', async () => {
    const { service, requestRaw, files, content } = harness();
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0;
    requestRaw.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(chunk);
          },
        }),
      ),
    );
    await service.ingest(connection, 'owner', 'outlook_mail', 'message', [{ id: 'att' }]);
    // 25 MiB fits; the 26th chunk is the one that crosses the limit and ends the read.
    expect(pulls).toBeLessThanOrEqual(MAX_MAIL_ATTACHMENT_BYTES / chunk.length + 2);
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source_data: expect.objectContaining({ ingestion_status: 'too_large' }) }),
    );
  });

  it('saves an Outlook file that arrives in several chunks whole', async () => {
    const { service, requestRaw, files } = harness();
    const encoder = new TextEncoder();
    requestRaw.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('pdf '));
            controller.enqueue(encoder.encode('bytes'));
            controller.close();
          },
        }),
      ),
    );
    await service.ingest(connection, 'owner', 'outlook_mail', 'message', [{ id: 'att' }]);
    expect(files.upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ buffer: Buffer.from('pdf bytes'), size: 9 }),
    );
  });

  it('reports an Outlook download the provider refuses', async () => {
    const { service, requestRaw, files, content } = harness();
    requestRaw.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    expect(await service.ingest(connection, 'owner', 'outlook_mail', 'message', [{ id: 'att' }])).toEqual({
      refs: [],
      failures: [new Error('Mail attachment download failed with HTTP 503')],
    });
    expect(files.upload).not.toHaveBeenCalled();
    expect(content.create).not.toHaveBeenCalled();
  });

  it('saves at most two attachments at a time, across messages', async () => {
    const { service, request } = harness();
    const release: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    request.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;

      return { data: Buffer.from('pdf bytes').toString('base64url') };
    });
    const saved = Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        service.ingest(connection, 'owner', 'gmail', `message-${n}`, [{ id: 'att' }]),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(running).toBe(2);

    let finished = 0;
    for (let turn = 0; turn < 20 && finished < 5; turn += 1) {
      const waiting = release.splice(0);
      waiting.forEach((done) => done());
      finished += waiting.length;
      await new Promise((resolve) => setImmediate(resolve));
    }

    await saved;
    expect(finished).toBe(5);
    expect(peak).toBe(2);
  });

  it('gives its place back when a save fails', async () => {
    const { service, request } = harness();
    request.mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));
    expect((await service.ingest(connection, 'owner', 'gmail', 'one', [{ id: 'a' }])).failures).toHaveLength(
      1,
    );
    expect((await service.ingest(connection, 'owner', 'gmail', 'two', [{ id: 'b' }])).failures).toHaveLength(
      1,
    );
    expect(await service.ingest(connection, 'owner', 'gmail', 'three', [{ id: 'c' }])).toEqual({
      refs: [{ type: 'content', id: 'content-1' }],
      failures: [],
    });
  });
});

describe('mail attachment downloads and the connection access token', () => {
  const minutes = (count: number) => new Date(Date.now() + count * 60_000);
  const stored = (overrides: Partial<StoredConnection> = {}): StoredConnection => ({
    id: 'connection',
    providerId: 'provider',
    accessToken: 'old-token',
    refreshToken: 'refresh-token',
    tokenExpiry: minutes(-1),
    ...overrides,
  });
  const attachment = [{ id: 'att' }];

  it('downloads with the stored connection when a sync has renewed it since the transform began', async () => {
    const synced = stored({ accessToken: 'synced-token', tokenExpiry: minutes(50) });
    const { service, request, refreshAccessToken } = harness(null, synced);
    await service.ingest(connection, 'owner', 'gmail', 'message', attachment);
    expect(request).toHaveBeenCalledWith(synced, expect.any(String), expect.anything());
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('renews a token that has run out, keeps the new one and downloads with it', async () => {
    const { service, request, refreshAccessToken, connections } = harness(null, stored());
    await service.ingest(connection, 'owner', 'gmail', 'message', attachment);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    // A null refresh token means "keep yours", so it is not written.
    expect(connections.update).toHaveBeenCalledWith({ userId: 'owner' }, 'connection', {
      accessToken: 'renewed-token',
      tokenExpiry: expect.any(Date),
    });
    expect(request.mock.calls[0][0]).toMatchObject({ accessToken: 'renewed-token' });
  });

  it('renews a token that is about to run out, for an Outlook download too', async () => {
    const { service, requestRaw, refreshAccessToken } = harness(null, stored({ tokenExpiry: minutes(5) }));
    await service.ingest(connection, 'owner', 'outlook_mail', 'message', attachment);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(requestRaw.mock.calls[0][0]).toMatchObject({ accessToken: 'renewed-token' });
  });

  it('leaves a token with time left alone', async () => {
    const { service, refreshAccessToken, connections } = harness(null, stored({ tokenExpiry: minutes(30) }));
    await service.ingest(connection, 'owner', 'gmail', 'message', attachment);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(connections.update).not.toHaveBeenCalled();
  });

  it('keeps a refresh token the provider rotates', async () => {
    const { service, refreshAccessToken, connections } = harness(null, stored());
    refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'renewed-token',
      refreshToken: 'rotated-refresh-token',
      tokenExpiry: minutes(60),
    });
    await service.ingest(connection, 'owner', 'gmail', 'message', attachment);
    expect(connections.update).toHaveBeenCalledWith(
      { userId: 'owner' },
      'connection',
      expect.objectContaining({ refreshToken: 'rotated-refresh-token' }),
    );
  });

  it('shares one renewal between downloads that need it at the same time', async () => {
    const { service, refreshAccessToken } = harness(null, stored());
    refreshAccessToken.mockImplementation(async () => {
      await new Promise((resolve) => setImmediate(resolve));

      return { accessToken: 'renewed-token', refreshToken: null, tokenExpiry: minutes(60) };
    });
    await Promise.all([
      service.ingest(connection, 'owner', 'gmail', 'one', attachment),
      service.ingest(connection, 'owner', 'gmail', 'two', attachment),
    ]);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('downloads with the token it has, and says so, when the token cannot be renewed', async () => {
    const { service, request, refreshAccessToken, connections, logger } = harness(null, stored());
    refreshAccessToken.mockRejectedValueOnce(new Error('grant revoked'));
    await service.ingest(connection, 'owner', 'gmail', 'message', attachment);
    expect(connections.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not renew the access token for a mail attachment download',
      expect.objectContaining({ connectionId: 'connection', error: 'grant revoked' }),
    );
    expect(request.mock.calls[0][0]).toMatchObject({ accessToken: 'old-token' });
  });

  it('does not store a renewal that carries no access token', async () => {
    const { service, request, refreshAccessToken, connections } = harness(null, stored());
    refreshAccessToken.mockResolvedValueOnce({ accessToken: null, refreshToken: null, tokenExpiry: null });
    await service.ingest(connection, 'owner', 'gmail', 'message', attachment);
    expect(connections.update).not.toHaveBeenCalled();
    expect(request.mock.calls[0][0]).toMatchObject({ accessToken: 'old-token' });
  });

  it('does not look at the connection when nothing is downloaded', async () => {
    const { service, connections } = harness(null, stored());
    await service.ingest(connection, 'owner', 'gmail', 'message', [
      { id: 'inline', data: Buffer.from('photo').toString('base64url') },
      { id: 'linked', unsupported: true },
      { id: 'huge', size: MAX_MAIL_ATTACHMENT_BYTES + 1 },
    ]);
    expect(connections.findById).not.toHaveBeenCalled();
  });
});

describe('withAttachmentRefs', () => {
  const ref = { type: 'content', id: 'content-1' } as const;

  it('adds a reference the message does not hold, after what it already holds', () => {
    const importerFile = { type: 'file', id: 'file-1' };
    expect(withAttachmentRefs([importerFile], [ref])).toEqual([importerFile, ref]);
    expect(withAttachmentRefs(undefined, [ref])).toEqual([ref]);
    expect(withAttachmentRefs(null, [ref])).toEqual([ref]);
  });

  it('returns null when the message holds every reference, whatever order jsonb kept the keys in', () => {
    expect(withAttachmentRefs([{ id: 'content-1', type: 'content' }], [ref])).toBeNull();
    expect(withAttachmentRefs([ref], [ref])).toBeNull();
    expect(withAttachmentRefs([ref], [])).toBeNull();
  });

  it('does not confuse a content reference with a file of the same id', () => {
    expect(withAttachmentRefs([{ type: 'file', id: 'content-1' }], [ref])).toEqual([
      { type: 'file', id: 'content-1' },
      ref,
    ]);
  });

  it('adds a reference once however often it is given, and ignores entries it cannot read', () => {
    expect(withAttachmentRefs(['text', null, 7], [ref, { ...ref }])).toEqual(['text', null, 7, ref]);
  });
});
