import type { BaseClient, Connection } from '@ci/domains/connections';

export async function syncRecentlyPlayed({
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
  try {
    if (historical) {
      client.logger.log('Performing historical Spotify Recently Played sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const params = new URLSearchParams({
        limit: '50',
      });

      if (nextCursor?.before) {
        params.set('before', String(nextCursor.before));
      } else {
        params.set('before', String(new Date().getTime()));
      }

      const endpoint = nextCursor.nextUrl
        ? String(nextCursor.nextUrl)
        : `/v1/me/player/recently-played?${params.toString()}`;

      const response = (await client.request(connection, endpoint)) as {
        items: unknown[];
        next?: string;
        cursors?: { before: string };
      };

      const tracks = response.items || [];
      const nextUrl = response.next;

      client.logger.log('Spotify incremental Recently Played sync call completed', {
        connectionId: connection.id,
        trackCount: tracks.length,
        hasNextPage: !!nextUrl,
      });

      return {
        data: {
          tracks,
        },
        nextCursor: nextUrl
          ? {
              nextUrl,
            }
          : {},
      };
    } else {
      client.logger.log('Performing incremental Spotify Recently Played sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const params = new URLSearchParams({
        limit: '50',
      });

      if (nextCursor?.after) {
        params.set('after', String(nextCursor.after));
      } else {
        params.set('after', String(connection.createdAt.getTime()));
      }

      const endpoint = nextCursor.nextUrl
        ? String(nextCursor.nextUrl)
        : `/v1/me/player/recently-played?${params.toString()}`;

      const response = (await client.request(connection, endpoint)) as {
        items: unknown[];
        next?: string;
        cursors?: { before: string };
      };

      const tracks = response.items || [];
      const nextUrl = response.next;

      client.logger.log('Spotify incremental Recently Played sync call completed', {
        connectionId: connection.id,
        trackCount: tracks.length,
        hasNextPage: !!nextUrl,
      });

      return {
        data: {
          tracks,
        },
        nextCursor: nextUrl
          ? {
              nextUrl,
            }
          : {
              after: String(new Date().getTime()),
            },
      };
    }
  } catch (err) {
    client.logger.error('Failed to sync Spotify Recently Played', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}
