import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncGmail } from '../sync/SyncGmail';

const connection = { id: 'connection-1', createdAt: new Date('2026-01-01T00:00:00.000Z') } as Connection;

/** What `BaseOAuth2Client.request` throws for a Gmail 404. */
function notFoundError(): Error & { details: { code: number; message: string } } {
  const message = 'Requested entity was not found.';
  const err = new Error(message) as Error & { details: { code: number; message: string } };
  err.details = { code: 404, message };

  return err;
}

/** A mock client answering each request from the first route whose pattern matches its endpoint. */
function createMockClient(routes: Array<[RegExp, (endpoint: string) => unknown]>) {
  return {
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    request: jest.fn(async (_connection: Connection, endpoint: string) => {
      const route = routes.find(([pattern]) => pattern.test(endpoint));

      if (!route) {
        throw new Error(`Unexpected request: ${endpoint}`);
      }

      return route[1](endpoint);
    }),
  } as unknown as BaseClient;
}

function endpoints(client: BaseClient): string[] {
  return (client.request as jest.Mock).mock.calls.map((call) => call[1] as string);
}

const message = (id: string, labelIds = ['INBOX']) => ({ id, threadId: `t-${id}`, labelIds });

describe('syncGmail — incremental', () => {
  it('skips a message deleted since its history record, instead of failing every run', async () => {
    // The live failure: history named 1a11942651671878, messages.get 404'd, and the whole run
    // threw, so the cursor never moved and every run after it failed the same way.
    const client = createMockClient([
      [
        /\/history\?/,
        () => ({
          history: [
            { id: '1', messagesAdded: [{ message: { id: 'gone' } }] },
            { id: '2', messagesAdded: [{ message: { id: 'kept' } }] },
          ],
          historyId: '200',
        }),
      ],
      [
        /\/messages\/gone$/,
        () => {
          throw notFoundError();
        },
      ],
      [/\/messages\/kept$/, () => message('kept')],
    ]);

    const result = await syncGmail({
      connection,
      client,
      nextCursor: { startHistoryId: '100' },
      historical: false,
    });

    expect(result.data).toEqual({ messages: [message('kept')] });
    expect(result.nextCursor).toEqual({ startHistoryId: '200', historyIdAt: expect.any(String) });
    expect(client.logger.error).not.toHaveBeenCalled();
  });

  it('reads every message in a record, once each, plus mail newly labelled inbox or sent', async () => {
    const client = createMockClient([
      [
        /\/history\?/,
        () => ({
          history: [
            { id: '1', messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] },
            { id: '2', messagesAdded: [{ message: { id: 'a' } }] },
            { id: '3', labelsAdded: [{ message: { id: 'sent-draft' }, labelIds: ['SENT'] }] },
            { id: '4', labelsAdded: [{ message: { id: 'starred' }, labelIds: ['STARRED'] }] },
          ],
          historyId: '200',
        }),
      ],
      [/\/messages\/a$/, () => message('a')],
      [/\/messages\/b$/, () => message('b')],
      [/\/messages\/sent-draft$/, () => message('sent-draft', ['SENT'])],
    ]);

    const result = await syncGmail({
      connection,
      client,
      nextCursor: { startHistoryId: '100' },
      historical: false,
    });

    expect(result.data).toEqual({ messages: [message('a'), message('b'), message('sent-draft', ['SENT'])] });
    expect(endpoints(client).filter((e) => e.includes('/messages/'))).toHaveLength(3);
  });

  it('leaves out drafts, spam and trash', async () => {
    const client = createMockClient([
      [
        /\/history\?/,
        () => ({
          history: [
            { id: '1', messagesAdded: ['draft', 'spam', 'trash', 'mail'].map((id) => ({ message: { id } })) },
          ],
          historyId: '200',
        }),
      ],
      [/\/messages\/draft$/, () => message('draft', ['DRAFT'])],
      [/\/messages\/spam$/, () => message('spam', ['SPAM'])],
      [/\/messages\/trash$/, () => message('trash', ['TRASH'])],
      [/\/messages\/mail$/, () => message('mail', ['CATEGORY_PROMOTIONS', 'INBOX'])],
    ]);

    const result = await syncGmail({
      connection,
      client,
      nextCursor: { startHistoryId: '100' },
      historical: false,
    });

    expect(result.data).toEqual({ messages: [message('mail', ['CATEGORY_PROMOTIONS', 'INBOX'])] });
  });

  it('walks history page by page, keeping the start id and moving to the first page id at the end', async () => {
    // Reading one page and jumping to the mailbox's newest id skipped every record past the first 100.
    const pages: Record<string, unknown> = {
      first: {
        history: [{ id: '1', messagesAdded: [{ message: { id: 'a' } }] }],
        nextPageToken: 'p2',
        historyId: '200',
      },
      second: { history: [{ id: '2', messagesAdded: [{ message: { id: 'b' } }] }], historyId: '250' },
    };
    const client = createMockClient([
      [/\/history\?.*pageToken=p2/, () => pages.second],
      [/\/history\?/, () => pages.first],
      [/\/messages\/(\w+)$/, (e) => message(e.split('/').pop()!)],
    ]);

    const first = await syncGmail({
      connection,
      client,
      nextCursor: { startHistoryId: '100', historyIdAt: '2026-11-06T23:48:16.000Z' },
      historical: false,
    });

    expect(first.nextCursor).toEqual({
      startHistoryId: '100',
      historyIdAt: '2026-11-06T23:48:16.000Z',
      historyPageToken: 'p2',
      nextStartHistoryId: '200',
    });

    const second = await syncGmail({ connection, client, nextCursor: first.nextCursor!, historical: false });

    expect(endpoints(client).filter((e) => e.includes('/history?'))[1]).toContain('startHistoryId=100');
    expect(second.data).toEqual({ messages: [message('b')] });
    expect(second.nextCursor).toEqual({ startHistoryId: '200', historyIdAt: expect.any(String) });
  });

  it('when history has expired, takes a fresh point and lists the mail since the old one', async () => {
    const client = createMockClient([
      [
        /\/history\?/,
        () => {
          throw notFoundError();
        },
      ],
      [/\/profile$/, () => ({ historyId: '900' })],
    ]);

    const result = await syncGmail({
      connection,
      client,
      nextCursor: { startHistoryId: '100', historyIdAt: '2026-11-06T00:00:00.000Z' },
      historical: false,
    });

    const after = Date.parse('2026-11-05T00:00:00.000Z') / 1000;

    expect(result.data).toEqual({ messages: [] });
    expect(result.nextCursor).toEqual({
      startHistoryId: '900',
      historyIdAt: expect.any(String),
      catchUp: { query: `after:${after}` },
    });
    expect(client.logger.error).not.toHaveBeenCalled();
  });

  it('lists the whole mailbox when an expired cursor predates its timestamp', async () => {
    const client = createMockClient([
      [
        /\/history\?/,
        () => {
          throw notFoundError();
        },
      ],
      [/\/profile$/, () => ({ historyId: '900' })],
    ]);

    const result = await syncGmail({
      connection,
      client,
      nextCursor: { startHistoryId: '100' },
      historical: false,
    });

    expect(result.nextCursor).toEqual({
      startHistoryId: '900',
      historyIdAt: expect.any(String),
      catchUp: {},
    });
  });

  it('drains the catch-up one page per run, then resumes history from the fresh point', async () => {
    const client = createMockClient([
      [/\/messages\?.*pageToken=c2/, () => ({ messages: [{ id: 'b', threadId: 't-b' }] })],
      [/\/messages\?/, () => ({ messages: [{ id: 'a', threadId: 't-a' }], nextPageToken: 'c2' })],
      [/\/messages\/(\w+)$/, (e) => message(e.split('/').pop()!)],
    ]);
    const cursor = {
      startHistoryId: '900',
      historyIdAt: '2026-11-16T20:00:00.000Z',
      catchUp: { query: 'after:1' },
    };

    const first = await syncGmail({ connection, client, nextCursor: cursor, historical: false });

    expect(endpoints(client)[0]).toContain('q=after%3A1');
    expect(first.data).toEqual({ messages: [message('a')] });
    expect(first.nextCursor).toEqual({ ...cursor, catchUp: { query: 'after:1', pageToken: 'c2' } });

    const second = await syncGmail({ connection, client, nextCursor: first.nextCursor!, historical: false });

    expect(second.data).toEqual({ messages: [message('b')] });
    expect(second.nextCursor).toEqual({ startHistoryId: '900', historyIdAt: '2026-11-16T20:00:00.000Z' });
    expect(endpoints(client).some((e) => e.includes('/history?'))).toBe(false);
  });

  it('starts from the current history point on the first run', async () => {
    const client = createMockClient([[/\/profile$/, () => ({ historyId: '500' })]]);

    const result = await syncGmail({ connection, client, nextCursor: {}, historical: false });

    expect(result).toEqual({
      data: { messages: [] },
      nextCursor: { startHistoryId: '500', historyIdAt: expect.any(String) },
    });
  });

  it('still fails on any other error', async () => {
    const client = createMockClient([
      [
        /\/history\?/,
        () => {
          throw new Error('Request had insufficient authentication scopes.');
        },
      ],
    ]);

    await expect(
      syncGmail({ connection, client, nextCursor: { startHistoryId: '100' }, historical: false }),
    ).rejects.toThrow('insufficient authentication scopes');
  });
});

describe('syncGmail — historical', () => {
  it('skips a message deleted between the listing and the fetch', async () => {
    const client = createMockClient([
      [/\/messages\?.*labelIds=SENT/, () => ({ messages: [] })],
      [
        /\/messages\?/,
        () => ({
          messages: [
            { id: 'gone', threadId: 't' },
            { id: 'kept', threadId: 't-kept' },
          ],
        }),
      ],
      [
        /\/messages\/gone$/,
        () => {
          throw notFoundError();
        },
      ],
      [/\/messages\/kept$/, () => message('kept')],
    ]);

    const result = await syncGmail({ connection, client, nextCursor: {}, historical: true });

    expect(result.data).toEqual({ messages: [message('kept')] });
  });
});
