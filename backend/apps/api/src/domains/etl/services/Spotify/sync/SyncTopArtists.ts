import type { BaseClient, Connection } from '@ci/domains/connections';

export async function syncTopArtists({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing Spotify Top Artists sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const endpoint = nextCursor.nextUrl
      ? String(nextCursor.nextUrl)
      : `/v1/me/top/artists?limit=50&time_range=long_term`;

    const response = (await client.request(connection, endpoint)) as {
      items: unknown[];
      next?: string;
    };

    const artists = response.items || [];
    const nextUrl = response.next;

    client.logger.log('Spotify Top Artists sync call completed', {
      connectionId: connection.id,
      artistCount: artists.length,
      hasNextPage: !!nextUrl,
    });

    return {
      data: {
        artists,
      },
      nextCursor: nextUrl
        ? {
            nextUrl,
          }
        : {},
    };
  } catch (err) {
    client.logger.error('Failed to sync Spotify Top Artists', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}
