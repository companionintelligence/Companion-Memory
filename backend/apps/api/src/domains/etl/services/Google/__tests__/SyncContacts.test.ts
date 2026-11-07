import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncContacts } from '../sync/SyncContacts';

function createMockClient(impl: (endpoint: string) => unknown) {
  return {
    logger: {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    request: jest.fn(async (_connection: Connection, endpoint: string) => impl(endpoint)),
  } as unknown as BaseClient;
}

const connection = { id: 'connection-1', createdAt: new Date('2026-01-01T00:00:00.000Z') } as Connection;

/** What `BaseOAuth2Client.request` throws for the People API's expired-token answer. */
function expiredSyncTokenError(): Error & { details: { code: number; message: string } } {
  const message = 'Sync token is expired. Clear local cache and retry call without the sync token.';
  const err = new Error(message) as Error & { details: { code: number; message: string } };
  err.details = { code: 400, message };

  return err;
}

describe('syncContacts — incremental syncToken handling', () => {
  it('replays a stored syncToken and carries forward the fresh one Google returns', async () => {
    const client = createMockClient(() => ({
      connections: [{ resourceName: 'people/1' }],
      nextSyncToken: 'fresh',
    }));

    const result = await syncContacts({
      connection,
      client,
      nextCursor: { syncToken: 'stored' },
      historical: false,
    });

    expect(client.request).toHaveBeenCalledWith(connection, expect.stringContaining('syncToken=stored'));
    expect(result).toEqual({
      data: { contacts: [{ resourceName: 'people/1' }] },
      nextCursor: { syncToken: 'fresh' },
    });
  });

  it('clears the cursor instead of failing every tick when Google says the sync token expired', async () => {
    // Thrown, the dead token stayed the last successful cursor and the job failed every minute.
    const client = createMockClient(() => {
      throw expiredSyncTokenError();
    });

    const result = await syncContacts({
      connection,
      client,
      nextCursor: { syncToken: 'expired' },
      historical: false,
    });

    expect(result).toEqual({ data: { contacts: [] }, nextCursor: {} });
    expect(client.logger.warn).toHaveBeenCalledWith(
      'Contacts syncToken expired; clearing cursor for full resync',
      expect.objectContaining({ connectionId: 'connection-1' }),
    );
    expect(client.logger.error).not.toHaveBeenCalled();
  });

  it('runs token-less after the reset and lists contacts with a fresh sync token requested', async () => {
    const client = createMockClient(() => ({ connections: [], nextSyncToken: 'brand-new' }));

    const result = await syncContacts({ connection, client, nextCursor: {}, historical: false });

    const endpoint = (client.request as jest.Mock).mock.calls[0][1] as string;
    expect(endpoint).not.toContain('syncToken=');
    expect(endpoint).toContain('requestSyncToken=true');
    expect(result.nextCursor).toEqual({ syncToken: 'brand-new' });
  });

  it('still fails on any other error, and on an expired-token error when no token was sent', async () => {
    const other = createMockClient(() => {
      throw new Error('Request had insufficient authentication scopes.');
    });

    await expect(
      syncContacts({ connection, client: other, nextCursor: { syncToken: 'stored' }, historical: false }),
    ).rejects.toThrow('insufficient authentication scopes');

    const noToken = createMockClient(() => {
      throw expiredSyncTokenError();
    });

    await expect(
      syncContacts({ connection, client: noToken, nextCursor: {}, historical: false }),
    ).rejects.toThrow('Sync token is expired');
  });
});
