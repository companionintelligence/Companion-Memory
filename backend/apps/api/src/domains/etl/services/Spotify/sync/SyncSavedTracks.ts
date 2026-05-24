import type { BaseClient, Connection } from '@ci/domains/connections';

export async function syncSavedTracks({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing Spotify Saved Tracks sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const endpoint = nextCursor.nextUrl ? String(nextCursor.nextUrl) : `/v1/me/tracks?limit=50`;

    const response = (await client.request(connection, endpoint)) as {
      items: unknown[];
      next?: string;
    };

    const tracks = response.items || [];
    const nextUrl = response.next;

    client.logger.log('Spotify Saved Tracks sync call completed', {
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
  } catch (err) {
    client.logger.error('Failed to sync Spotify Saved Tracks', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}
