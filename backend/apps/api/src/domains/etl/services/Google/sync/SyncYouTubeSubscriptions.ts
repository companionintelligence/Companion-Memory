import type { BaseClient, Connection } from '@ci/domains/connections';

interface YouTubeItem {
  id: string;
  snippet?: Record<string, unknown>;
  contentDetails?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function syncYouTubeSubscriptions({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing historical YouTube sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      maxResults: '50',
      mine: 'true',
    });

    if (nextCursor.pageToken) {
      params.set('pageToken', nextCursor.pageToken as string);
    }

    const endpoint = `/youtube/v3/subscriptions?${params.toString()}`;
    const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
    const subscriptions = (response.items as YouTubeItem[]) || [];
    const nextPageToken = response.nextPageToken as string | undefined;

    client.logger.log('YouTube playlists sync completed', {
      connectionId: connection.id,
      subscriptionCount: subscriptions.length,
      hasNextPage: !!nextPageToken,
    });

    return {
      data: { items: subscriptions },
      nextCursor: nextPageToken ? { pageToken: nextPageToken } : {},
    };
  } catch (err) {
    client.logger.error('Error during YouTube Subscriptions sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
