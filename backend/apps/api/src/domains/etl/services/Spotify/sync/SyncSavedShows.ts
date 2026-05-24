import type { BaseClient, Connection } from '@ci/domains/connections';

export async function syncSavedShows({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing Spotify Saved Shows sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const endpoint = nextCursor.nextUrl ? String(nextCursor.nextUrl) : `/v1/me/shows?limit=50`;

    const response = (await client.request(connection, endpoint)) as {
      items: unknown[];
      next?: string;
    };

    const shows = response.items || [];
    const nextUrl = response.next;

    client.logger.log('Spotify Saved Shows sync call completed', {
      connectionId: connection.id,
      showCount: shows.length,
      hasNextPage: !!nextUrl,
    });

    return {
      data: {
        shows,
      },
      nextCursor: nextUrl
        ? {
            nextUrl,
          }
        : {},
    };
  } catch (err) {
    client.logger.error('Failed to sync Spotify Saved Shows', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}
