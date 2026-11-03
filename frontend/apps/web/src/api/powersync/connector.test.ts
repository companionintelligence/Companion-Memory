import { GlobalUID, setApiBaseUrl, setApiKey } from '@ci/common';
import { UpdateType, type AbstractPowerSyncDatabase, type CrudEntry } from '@powersync/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLBackendConnector } from './connector';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();

  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

function fakeCrudEntry(overrides: Partial<CrudEntry>): CrudEntry {
  return {
    clientId: 1,
    id: 'row-1',
    op: UpdateType.PUT,
    table: 'notes',
    opData: {},
    ...overrides,
  } as CrudEntry;
}

function fakeDatabase(crud: CrudEntry[]): {
  database: AbstractPowerSyncDatabase;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn().mockResolvedValue(undefined);

  const transaction = crud.length > 0 ? { crud, complete } : null;

  const database = {
    getNextCrudTransaction: vi.fn().mockResolvedValue(transaction),
  } as unknown as AbstractPowerSyncDatabase;

  return { database, complete };
}

beforeEach(() => {
  setApiBaseUrl('');
  setApiKey(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiBaseUrl('');
  setApiKey(null);
});

describe('GraphQLBackendConnector.fetchCredentials', () => {
  it('returns null without a network call when there is no token or api key', async () => {
    const fetchMock = stubFetch();
    const connector = new GraphQLBackendConnector(() => null);

    const credentials = await connector.fetchCredentials();

    expect(credentials).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the powersync token with a Bearer header when a JWT is present', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ token: 'ps-token', powersync_url: 'https://sync.example.com' }),
    );
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    const credentials = await connector.fetchCredentials();

    expect(credentials).toEqual({ endpoint: 'https://sync.example.com', token: 'ps-token' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toContain('/api/powersync/token');
    expect(url).toContain('cutoff=');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt-abc');
  });

  it('fetches with the x-api-key header on native (no JWT)', async () => {
    setApiKey('native-key');
    const fetchMock = stubFetch(
      jsonResponse({ token: 'ps-token', powersync_url: 'https://sync.example.com' }),
    );
    const connector = new GraphQLBackendConnector(() => null);

    await connector.fetchCredentials();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect((init.headers as Record<string, string>)['x-api-key']).toBe('native-key');
  });

  it('throws on a non-ok response so PowerSync retries', async () => {
    stubFetch(jsonResponse({}, false, 500));
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await expect(connector.fetchCredentials()).rejects.toThrow('500');
  });

  it('returns null and reports it when the server runs no PowerSync service', async () => {
    setApiBaseUrl('https://memory-a.example');
    stubFetch(
      jsonResponse(
        {
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'PowerSync is not configured',
          code: 'POWERSYNC_NOT_CONFIGURED',
        },
        false,
        503,
      ),
    );
    const onSyncUnavailable = vi.fn();
    const connector = new GraphQLBackendConnector(() => 'jwt-abc', onSyncUnavailable);

    await expect(connector.fetchCredentials()).resolves.toBeNull();
    expect(onSyncUnavailable).toHaveBeenCalledTimes(1);
    expect(onSyncUnavailable).toHaveBeenCalledWith('https://memory-a.example');
  });

  it('recognises the same answer from servers released before it carried a code', async () => {
    stubFetch(
      jsonResponse(
        { statusCode: 503, error: 'Service Unavailable', message: 'PowerSync is not configured' },
        false,
        503,
      ),
    );
    const onSyncUnavailable = vi.fn();
    const connector = new GraphQLBackendConnector(() => 'jwt-abc', onSyncUnavailable);

    await expect(connector.fetchCredentials()).resolves.toBeNull();
    expect(onSyncUnavailable).toHaveBeenCalledTimes(1);
  });

  it('throws on any other 503 so PowerSync retries, and does not report sync as off', async () => {
    stubFetch(jsonResponse({ statusCode: 503, message: 'Service Unavailable' }, false, 503));
    const onSyncUnavailable = vi.fn();
    const connector = new GraphQLBackendConnector(() => 'jwt-abc', onSyncUnavailable);

    await expect(connector.fetchCredentials()).rejects.toThrow('503');
    expect(onSyncUnavailable).not.toHaveBeenCalled();
  });

  it('treats a 503 page that is not JSON (a proxy while the server restarts) as transient', async () => {
    stubFetch({
      ok: false,
      status: 503,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);
    const onSyncUnavailable = vi.fn();
    const connector = new GraphQLBackendConnector(() => 'jwt-abc', onSyncUnavailable);

    await expect(connector.fetchCredentials()).rejects.toThrow('503');
    expect(onSyncUnavailable).not.toHaveBeenCalled();
  });

  it('gives up on a token request that never finishes, so PowerSync can retry', async () => {
    vi.useFakeTimers();

    try {
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      );

      vi.stubGlobal('fetch', fetchMock);
      const connector = new GraphQLBackendConnector(() => 'jwt-abc');
      const pending = expect(connector.fetchCredentials()).rejects.toThrow('Aborted');

      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GraphQLBackendConnector.uploadData', () => {
  it('does nothing when there is no pending transaction', async () => {
    const fetchMock = stubFetch();
    const { database } = fakeDatabase([]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replays a note PUT as createNote and completes the transaction', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ data: { createNote: { success: true, note: { id: 'gid' } } } }),
    );
    const op = fakeCrudEntry({
      op: UpdateType.PUT,
      table: 'notes',
      id: 'local-1',
      opData: { title: 'Hi', content: '<p>Hi</p>' },
    });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.query).toContain('createNote');
    // The row's own id travels with the create, so the server keeps it.
    expect(body.variables).toEqual({
      input: { id: GlobalUID.encode('note', 'local-1'), title: 'Hi', content: '<p>Hi</p>' },
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('replays a note PATCH as updateNote with the base64 global id', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: { updateNote: { success: true } } }));
    const op = fakeCrudEntry({
      op: UpdateType.PATCH,
      table: 'notes',
      id: 'local-1',
      opData: { title: 'New title' },
    });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.query).toContain('updateNote');
    expect(body.variables.input.id).toBe(btoa('note:local-1'));
    expect(body.variables.input.title).toBe('New title');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('replays a note DELETE as deleteNote with the base64 global id', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: { deleteNote: { success: true } } }));
    const op = fakeCrudEntry({ op: UpdateType.DELETE, table: 'notes', id: 'local-1' });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.query).toContain('deleteNote');
    expect(body.variables.input.id).toBe(btoa('note:local-1'));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('replays a saved-search PUT as createSavedSearch with its arrays and filters parsed back from JSON text', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ data: { createSavedSearch: { success: true, savedSearch: { id: 'gid' } } } }),
    );
    const op = fakeCrudEntry({
      op: UpdateType.PUT,
      table: 'saved_searches',
      id: 'ss-1',
      opData: {
        name: 'Work emails',
        description: null,
        query: 'quarterly',
        entity_types: '["communication"]',
        tags: '["work"]',
        filters: '{"direction":"inbound"}',
        is_public: 0,
        share_token: null,
        is_seed: 0,
        created_at: '2026-10-26T10:00:00.000Z',
        updated_at: '2026-10-26T10:00:00.000Z',
      },
    });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.query).toContain('createSavedSearch');
    expect(body.variables).toEqual({
      input: {
        id: GlobalUID.encode('saved-search', 'ss-1'),
        name: 'Work emails',
        description: null,
        query: 'quarterly',
        entityTypes: ['communication'],
        tags: ['work'],
        filters: { direction: 'inbound' },
      },
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('replays a saved-search PATCH with only the changed columns, never the sharing or timestamp ones', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: { updateSavedSearch: { success: true } } }));
    const op = fakeCrudEntry({
      op: UpdateType.PATCH,
      table: 'saved_searches',
      id: 'ss-1',
      opData: { name: 'Renamed', filters: null, updated_at: '2026-10-26T11:00:00.000Z' },
    });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.query).toContain('updateSavedSearch');
    expect(body.variables.input).toEqual({ id: btoa('saved-search:ss-1'), name: 'Renamed', filters: null });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('replays a saved-search DELETE as deleteSavedSearch', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: { deleteSavedSearch: { success: true } } }));
    const op = fakeCrudEntry({ op: UpdateType.DELETE, table: 'saved_searches', id: 'ss-1' });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.query).toContain('deleteSavedSearch');
    expect(body.variables.input.id).toBe(btoa('saved-search:ss-1'));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('ignores writes against read-only tables without calling the network', async () => {
    const fetchMock = stubFetch();
    const op = fakeCrudEntry({ op: UpdateType.PUT, table: 'tags', id: 'tag-1', opData: { label: 'x' } });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  // events and entities synced read-only until 2026-10-21 and then left the
  // schema. A CRUD entry for either — one a stale replica queued before the
  // table went — must be dropped, not sent: there is no mutation behind them,
  // so anything that escaped here would 404 against the GraphQL endpoint on
  // every sync and wedge the upload queue. entity_tag is the read-only join
  // that still syncs.
  it.each(['events', 'entities', 'entity_tag'])('ignores writes against the %s table', async (table) => {
    const fetchMock = stubFetch();
    const op = fakeCrudEntry({ op: UpdateType.PUT, table, id: 'row-1', opData: { name: 'x' } });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('drops a permanently-rejected record (GraphQL error) and still completes', async () => {
    const fetchMock = stubFetch(jsonResponse({ errors: [{ message: 'Tag label cannot be empty' }] }));
    const op = fakeCrudEntry({ op: UpdateType.PUT, table: 'notes', id: 'local-1', opData: {} });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('drops a record whose mutation reports success: false and still completes', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: { updateNote: { success: false } } }));
    const op = fakeCrudEntry({
      op: UpdateType.PATCH,
      table: 'notes',
      id: 'ghost-id',
      opData: { title: 'x' },
    });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await connector.uploadData(database);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('propagates a transient transport failure and does not complete the transaction', async () => {
    stubFetch(jsonResponse({}, false, 503));
    const op = fakeCrudEntry({ op: UpdateType.PUT, table: 'notes', id: 'local-1', opData: {} });
    const { database, complete } = fakeDatabase([op]);
    const connector = new GraphQLBackendConnector(() => 'jwt-abc');

    await expect(connector.uploadData(database)).rejects.toThrow('503');
    expect(complete).not.toHaveBeenCalled();
  });
});
