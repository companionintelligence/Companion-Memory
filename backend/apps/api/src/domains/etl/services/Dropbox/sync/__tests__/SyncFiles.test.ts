import { syncFiles } from '../SyncFiles';

function build(rpc: jest.Mock) {
  const client = { rpc, logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } };
  const connection = { id: 'conn-1' } as never;

  return { client: client as never, connection, rpc };
}

const file = (name: string) => ({ '.tag': 'file', id: `id:${name}`, name, rev: 'r1', size: 10 });

describe('Dropbox syncFiles', () => {
  it('historical: lists the whole Dropbox recursively and keeps only files', async () => {
    const { client, connection, rpc } = build(
      jest.fn(async () => ({
        entries: [file('a.pdf'), { '.tag': 'folder', id: 'id:f', name: 'Folder' }, file('b.zip')],
        cursor: 'cursor-1',
        has_more: true,
      })),
    );

    const result = await syncFiles({ connection, client, nextCursor: {}, historical: true });

    expect(rpc).toHaveBeenCalledWith(
      connection,
      '/2/files/list_folder',
      expect.objectContaining({ path: '', recursive: true, include_non_downloadable_files: false }),
    );
    expect((result.data.files as Array<{ name: string }>).map((f) => f.name)).toEqual(['a.pdf', 'b.zip']);
    // More pages: the cursor carries the walk to the next job.
    expect(result.nextCursor).toEqual({ cursor: 'cursor-1' });
  });

  it('historical: continues from a cursor and ends with an empty one', async () => {
    const { client, connection, rpc } = build(
      jest.fn(async () => ({ entries: [file('c.txt')], cursor: 'cursor-2', has_more: false })),
    );

    const result = await syncFiles({
      connection,
      client,
      nextCursor: { cursor: 'cursor-1' },
      historical: true,
    });

    expect(rpc).toHaveBeenCalledWith(connection, '/2/files/list_folder/continue', { cursor: 'cursor-1' });
    // Empty cursor is how the orchestrator knows the walk is finished.
    expect(result.nextCursor).toEqual({});
  });

  it('incremental: the first job only anchors a cursor at "now"', async () => {
    const { client, connection, rpc } = build(jest.fn(async () => ({ cursor: 'latest' })));

    const result = await syncFiles({ connection, client, nextCursor: {}, historical: false });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toBe('/2/files/list_folder/get_latest_cursor');
    expect(result).toEqual({ data: { files: [] }, nextCursor: { cursor: 'latest' } });
  });

  it('incremental: returns what changed and always keeps the newest cursor', async () => {
    const { client, connection, rpc } = build(
      jest.fn(async () => ({
        entries: [file('new.pdf'), { '.tag': 'deleted', name: 'gone.pdf' }],
        cursor: 'after',
        has_more: false,
      })),
    );

    const result = await syncFiles({
      connection,
      client,
      nextCursor: { cursor: 'latest' },
      historical: false,
    });

    expect(rpc).toHaveBeenCalledWith(connection, '/2/files/list_folder/continue', { cursor: 'latest' });
    expect((result.data.files as Array<{ name: string }>).map((f) => f.name)).toEqual(['new.pdf']);
    expect(result.nextCursor).toEqual({ cursor: 'after' });
  });

  it('starts over when Dropbox says the cursor has expired', async () => {
    const { client, connection } = build(
      jest.fn(async () => {
        throw new Error('Dropbox API request failed: 409 reset/..');
      }),
    );

    const result = await syncFiles({
      connection,
      client,
      nextCursor: { cursor: 'stale' },
      historical: false,
    });

    expect(result).toEqual({ data: { files: [] }, nextCursor: {} });
  });

  it('rethrows any other failure', async () => {
    const { client, connection } = build(
      jest.fn(async () => {
        throw new Error('Dropbox API request failed: 401 expired_access_token/');
      }),
    );

    await expect(
      syncFiles({ connection, client, nextCursor: { cursor: 'c' }, historical: true }),
    ).rejects.toThrow('expired_access_token');
  });
});
