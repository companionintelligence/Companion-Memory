import { DropboxClient } from '../DropboxClient';

function build() {
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = new DropboxClient(logger as never);
  const connection = { id: 'conn-1', accessToken: 'access-token', activeEndpoints: ['Files'] } as never;

  return { client, connection };
}

describe('DropboxClient', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('asks for read-only scopes for the Files endpoint', () => {
    const { client } = build();

    expect(client.getScopesFromActiveEndpoints(['Files']).split(' ').sort()).toEqual([
      'account_info.read',
      'files.content.read',
      'files.metadata.read',
    ]);
  });

  it('rpc: POSTs JSON arguments with the bearer token', async () => {
    const { client, connection } = build();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ cursor: 'c' }), { status: 200 }));

    expect(await client.rpc(connection, '/2/files/list_folder/continue', { cursor: 'x' })).toEqual({
      cursor: 'c',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.dropboxapi.com/2/files/list_folder/continue');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"cursor":"x"}');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
    });
  });

  it('rpc: sends the JSON literal null for a no-argument call', async () => {
    const { client, connection } = build();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ account_id: 'dbid:1' }), { status: 200 }));

    expect(await client.getAccountIdentifier(connection)).toBe('dbid:1');
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBe('null');
  });

  it("rpc: puts Dropbox's error summary in the thrown message", async () => {
    const { client, connection } = build();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error_summary: 'reset/..', error: { '.tag': 'reset' } }), {
        status: 409,
      }),
    );

    await expect(client.rpc(connection, '/2/files/list_folder/continue', { cursor: 'x' })).rejects.toThrow(
      'Dropbox API request failed: 409 reset/..',
    );
  });

  it('download: hits the content host with the file id in the API-arg header, and a range when asked', async () => {
    const { client, connection } = build();
    fetchMock.mockResolvedValue(new Response('bytes', { status: 206 }));

    await client.download(connection, 'id:abc', { offset: 100, length: 50 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://content.dropboxapi.com/2/files/download');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'Dropbox-API-Arg': '{"path":"id:abc"}',
      Range: 'bytes=100-149',
    });
    expect(init.body).toBeUndefined();
  });

  it('revoke: calls the revoke endpoint with the live access token and never throws', async () => {
    const { client, connection } = build();
    fetchMock.mockResolvedValueOnce(new Response('null', { status: 200 }));

    expect(await client.revoke(connection)).toEqual({ revoked: true });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://api.dropboxapi.com/2/auth/token/revoke');

    fetchMock.mockResolvedValueOnce(
      new Response('{"error_summary":"expired_access_token/"}', { status: 401 }),
    );
    expect(await client.revoke(connection)).toEqual({ revoked: false });

    expect(await client.revoke({ id: 'c', accessToken: null } as never)).toEqual({ revoked: false });
  });
});
