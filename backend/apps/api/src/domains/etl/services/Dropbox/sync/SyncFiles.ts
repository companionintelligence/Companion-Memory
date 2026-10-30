import type { BaseClient, Connection, DropboxClient } from '@ci/domains/connections';

/** One entry of a Dropbox folder listing. Only `file` entries are kept. */
export interface DropboxFile {
  '.tag': 'file' | 'folder' | 'deleted';
  /** Stable across renames and moves, e.g. `id:a4ayc_80_OEAAAAAAAAAXw`. */
  id: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  /** Changes whenever the content does. */
  rev?: string;
  size?: number;
  server_modified?: string;
  client_modified?: string;
  is_downloadable?: boolean;
  [key: string]: unknown;
}

interface ListFolderResult {
  entries: DropboxFile[];
  cursor: string;
  has_more: boolean;
}

/**
 * The whole Dropbox, root down. Online-only placeholders that have no bytes
 * to fetch (Paper docs, Google Docs shortcuts) are left out at the source.
 */
const LIST_ARGS = {
  path: '',
  recursive: true,
  include_deleted: false,
  include_non_downloadable_files: false,
};

const PAGE_SIZE = 500;

/**
 * Historical: page through `list_folder` until `has_more` runs out.
 *
 * Incremental: Dropbox's own change feed. `list_folder/continue` with a saved
 * cursor returns exactly what changed since that cursor was issued. The first
 * incremental job has no cursor, so it asks for "the cursor as of now"
 * (`get_latest_cursor`) and returns no files — everything that already exists
 * is the historical walk's job, and every change from this moment on is then
 * this cursor's.
 *
 * A cursor Dropbox has expired answers `reset`; the walk then starts over
 * (historical) or re-anchors at now (incremental) instead of failing forever.
 */
export async function syncFiles({
  connection,
  client,
  nextCursor,
  historical = false,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  const dropbox = client as DropboxClient;
  const cursor = typeof nextCursor.cursor === 'string' ? nextCursor.cursor : undefined;

  try {
    if (!historical && !cursor) {
      const latest = await dropbox.rpc<{ cursor: string }>(
        connection,
        '/2/files/list_folder/get_latest_cursor',
        LIST_ARGS,
      );

      return { data: { files: [] }, nextCursor: { cursor: latest.cursor } };
    }

    let result: ListFolderResult;

    try {
      result = cursor
        ? await dropbox.rpc<ListFolderResult>(connection, '/2/files/list_folder/continue', { cursor })
        : await dropbox.rpc<ListFolderResult>(connection, '/2/files/list_folder', {
            ...LIST_ARGS,
            limit: PAGE_SIZE,
          });
    } catch (err) {
      if (cursor && err instanceof Error && /\breset\b/.test(err.message)) {
        client.logger.warn('Dropbox cursor expired; starting over', {
          connectionId: connection.id,
          historical,
        });

        return { data: { files: [] }, nextCursor: {} };
      }

      throw err;
    }

    const files = result.entries.filter((entry) => entry['.tag'] === 'file');

    client.logger.log('Dropbox sync call completed', {
      connectionId: connection.id,
      historical,
      fileCount: files.length,
      hasMore: result.has_more,
    });

    return {
      data: { files },
      // Historical ends when the listing does. Incremental always keeps the
      // newest cursor: it is the position in the change feed.
      nextCursor: historical ? (result.has_more ? { cursor: result.cursor } : {}) : { cursor: result.cursor },
    };
  } catch (err) {
    client.logger.error('Error during Dropbox sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
