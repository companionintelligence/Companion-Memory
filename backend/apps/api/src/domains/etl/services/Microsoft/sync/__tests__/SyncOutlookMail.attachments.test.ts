import { syncOutlookMail } from '../SyncOutlookMail';

const connection = { id: 'connection', createdAt: new Date('2026-10-01T00:00:00Z') } as never;
const message = { id: 'message', hasAttachments: true, receivedDateTime: '2026-10-02T00:00:00Z' };
const attachmentPath =
  '/v1.0/me/messages/message/attachments?$select=id,lastModifiedDateTime,name,contentType,size,isInline&$top=100';

it('includes every attachment metadata page before advancing the mail cursor', async () => {
  const next = 'https://graph.microsoft.com/v1.0/me/messages/message/attachments?$skip=100';
  const request = jest.fn(async (_connection: unknown, path: string) => {
    if (path === attachmentPath) {
      return { value: [{ id: 'first' }], '@odata.nextLink': next };
    }

    if (path === next) {
      return { value: [{ id: 'last' }] };
    }

    return { value: [{ ...message }] };
  });
  const client = { request, logger: { log: jest.fn(), error: jest.fn() } } as never;
  const result = await syncOutlookMail({ connection, client, nextCursor: {}, historical: true });
  expect((result.data.messages as Array<{ attachments: unknown[] }>)[0].attachments).toEqual([
    { id: 'first' },
    { id: 'last' },
  ]);
});

it('fails the page if attachment metadata cannot be read, retaining retryability', async () => {
  const request = jest.fn(async (_connection: unknown, path: string) => {
    if (path === attachmentPath) {
      throw new Error('permission expired');
    }

    return { value: [{ ...message }] };
  });
  const client = { request, logger: { log: jest.fn(), error: jest.fn() } } as never;
  await expect(syncOutlookMail({ connection, client, nextCursor: {}, historical: false })).rejects.toThrow(
    'permission expired',
  );
});

it('finds inline-only attachments even when Graph hasAttachments is false', async () => {
  const request = jest.fn(async (_connection: unknown, path: string) =>
    path === attachmentPath
      ? { value: [{ id: 'inline-photo', isInline: true }] }
      : { value: [{ ...message, hasAttachments: false, body: { content: '<IMG src="cid:photo">' } }] },
  );
  const client = { request, logger: { log: jest.fn(), error: jest.fn() } } as never;
  const result = await syncOutlookMail({ connection, client, nextCursor: {}, historical: false });
  expect((result.data.messages as Array<{ attachments: unknown[] }>)[0].attachments).toEqual([
    { id: 'inline-photo', isInline: true },
  ]);
});

it('rejects an attachment pagination link outside Microsoft Graph', async () => {
  const request = jest.fn(async (_connection: unknown, path: string) =>
    path === attachmentPath
      ? { value: [], '@odata.nextLink': 'https://outside.example/attachments' }
      : { value: [{ ...message }] },
  );
  const client = { request, logger: { log: jest.fn(), error: jest.fn() } } as never;
  await expect(syncOutlookMail({ connection, client, nextCursor: {}, historical: true })).rejects.toThrow(
    'expected provider resource',
  );
  expect(request).toHaveBeenCalledTimes(2);
});

describe('the attachment list of a message whose id contains "="', () => {
  const id = 'AAMkAGI=';
  const firstPage = `/v1.0/me/messages/${encodeURIComponent(id)}/attachments?$select=id,lastModifiedDateTime,name,contentType,size,isInline&$top=100`;

  /** A mailbox that holds one message with this id and two pages of attachments, the second reached by `next`. */
  function mailbox(next: string) {
    return jest.fn(async (_connection: unknown, path: string) => {
      if (path === firstPage) {
        return { value: [{ id: 'first' }], '@odata.nextLink': next };
      }

      if (path.includes('$skip=100')) {
        return { value: [{ id: 'last' }] };
      }

      return { value: [{ ...message, id }] };
    });
  }

  // Graph may write the id with a literal `=` or percent-encoded, and both name the same message.
  it.each([
    ['a literal =', 'https://graph.microsoft.com/v1.0/me/messages/AAMkAGI=/attachments?$skip=100'],
    ['an encoded =', 'https://graph.microsoft.com/v1.0/me/messages/AAMkAGI%3D/attachments?$skip=100'],
  ])('follows a next link that writes the id with %s', async (_form, next) => {
    const request = mailbox(next);
    const client = { request, logger: { log: jest.fn(), error: jest.fn() } } as never;
    const result = await syncOutlookMail({ connection, client, nextCursor: {}, historical: true });
    expect((result.data.messages as Array<{ attachments: unknown[] }>)[0].attachments).toEqual([
      { id: 'first' },
      { id: 'last' },
    ]);
  });

  it.each([
    [
      'the attachments of another message',
      'https://graph.microsoft.com/v1.0/me/messages/other/attachments?$skip=100',
    ],
    ['another resource of the message', 'https://graph.microsoft.com/v1.0/me/messages/AAMkAGI%3D?$skip=100'],
    [
      'a path that is not valid percent-encoding',
      'https://graph.microsoft.com/v1.0/me/messages/AAMkAGI%3D/attachments%E0%A4%A?$skip=100',
    ],
    ['another host', 'https://outside.example/v1.0/me/messages/AAMkAGI%3D/attachments?$skip=100'],
  ])('refuses a next link to %s', async (_what, next) => {
    const request = mailbox(next);
    const client = { request, logger: { log: jest.fn(), error: jest.fn() } } as never;
    await expect(syncOutlookMail({ connection, client, nextCursor: {}, historical: true })).rejects.toThrow(
      'expected provider resource',
    );
    // The list message, the first page, and nothing past the refused link.
    expect(request).toHaveBeenCalledTimes(2);
  });
});
