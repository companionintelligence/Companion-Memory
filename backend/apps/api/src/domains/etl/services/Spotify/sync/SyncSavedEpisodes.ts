import type { BaseClient, Connection } from '@ci/domains/connections';

export async function syncSavedEpisodes({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing Spotify Saved Episodes sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const endpoint = nextCursor.nextUrl ? String(nextCursor.nextUrl) : `/v1/me/episodes?limit=50`;

    const response = (await client.request(connection, endpoint)) as {
      items: unknown[];
      next?: string;
    };

    const episodes = response.items || [];
    const nextUrl = response.next;

    client.logger.log('Spotify Saved Episodes sync call completed', {
      connectionId: connection.id,
      episodeCount: episodes.length,
      hasNextPage: !!nextUrl,
    });

    return {
      data: {
        episodes,
      },
      nextCursor: nextUrl
        ? {
            nextUrl,
          }
        : {},
    };
  } catch (err) {
    client.logger.error('Failed to sync Spotify Saved Episodes', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}
