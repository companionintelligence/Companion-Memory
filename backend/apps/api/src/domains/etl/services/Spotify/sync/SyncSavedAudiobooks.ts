import type { BaseClient, Connection } from '@ci/domains/connections';

export async function syncSavedAudiobooks({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing Spotify Saved Audiobooks sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const endpoint = nextCursor.nextUrl ? String(nextCursor.nextUrl) : `/v1/me/audiobooks?limit=50`;

    const response = (await client.request(connection, endpoint)) as {
      items: unknown[];
      next?: string;
    };

    const audiobooks = response.items || [];
    const nextUrl = response.next;

    client.logger.log('Spotify Saved Audiobooks sync call completed', {
      connectionId: connection.id,
      audiobookCount: audiobooks.length,
      hasNextPage: !!nextUrl,
    });

    return {
      data: {
        audiobooks,
      },
      nextCursor: nextUrl
        ? {
            nextUrl,
          }
        : {},
    };
  } catch (err) {
    client.logger.error('Failed to sync Spotify Saved Audiobooks', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}
