import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncCalendar } from '../sync/SyncCalendar';

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

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'connection-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Connection;
}

/** Mirrors the shape `BaseOAuth2Client.request` throws for a parsed Google error body. */
function googleApiError(code: number, message: string): Error & { details: { code: number; message: string } } {
  const err = new Error(message) as Error & { details: { code: number; message: string } };
  err.details = { code, message };

  return err;
}

describe('syncCalendar — incremental syncToken handling', () => {
  it('replays a stored syncToken and carries forward the fresh one Google returns', async () => {
    const client = createMockClient(() => ({
      items: [{ id: 'evt-1' }],
      nextSyncToken: 'fresh-token',
    }));
    const connection = createConnection();

    const result = await syncCalendar({
      connection,
      client,
      nextCursor: { syncToken: 'stale-but-valid-token' },
      historical: false,
    });

    expect(client.request).toHaveBeenCalledWith(
      connection,
      expect.stringContaining('syncToken=stale-but-valid-token'),
    );
    expect(result.nextCursor).toEqual({ syncToken: 'fresh-token' });
  });

  it('clears the cursor instead of throwing when Google answers 410 fullSyncRequired for a stored syncToken', async () => {
    const client = createMockClient(() => {
      throw googleApiError(410, 'Sync token is no longer valid, a full sync is required.');
    });
    const connection = createConnection();

    const result = await syncCalendar({
      connection,
      client,
      nextCursor: { syncToken: 'dead-token' },
      historical: false,
    });

    // A benign empty success, not a thrown error — so this job lands as
    // `status: 'success'` and becomes the orchestrator's next `lastSuccess`,
    // rather than leaving the dead token as the latest success forever.
    expect(result).toEqual({ data: { items: [] }, nextCursor: {} });
    expect(client.logger.warn).toHaveBeenCalled();
  });

  it('re-throws a 410 that did not come from replaying a syncToken', async () => {
    const client = createMockClient(() => {
      throw googleApiError(410, 'Sync token is no longer valid, a full sync is required.');
    });
    const connection = createConnection();

    // No stored syncToken — this is a fresh (or page-token) fetch, so a 410
    // here is not the dead-token case the fix targets and must still fail
    // the job loudly.
    await expect(
      syncCalendar({
        connection,
        client,
        nextCursor: {},
        historical: false,
      }),
    ).rejects.toThrow(/Sync token/);
  });

  it('re-throws a non-410 error even when a syncToken was in play', async () => {
    const client = createMockClient(() => {
      throw googleApiError(500, 'Internal error');
    });
    const connection = createConnection();

    await expect(
      syncCalendar({
        connection,
        client,
        nextCursor: { syncToken: 'some-token' },
        historical: false,
      }),
    ).rejects.toThrow('Internal error');
  });
});
