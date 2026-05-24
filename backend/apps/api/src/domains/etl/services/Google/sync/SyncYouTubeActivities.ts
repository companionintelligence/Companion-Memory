import type { BaseClient, Connection } from '@ci/domains/connections';

interface YouTubeItem {
  id: string;
  snippet?: Record<string, unknown>;
  contentDetails?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function syncYouTubeActivities({
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
      client.logger.log('Performing historical YouTube Activities sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const publishedBefore = (nextCursor.publishedBefore as string) || connection.createdAt.toISOString();

      const params = new URLSearchParams({
        part: 'snippet,contentDetails',
        maxResults: '50',
        mine: 'true',
        publishedBefore: publishedBefore,
      });

      if (nextCursor.pageToken) {
        params.set('pageToken', nextCursor.pageToken as string);
      }

      const endpoint = `/youtube/v3/activities?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const activities = (response.items as YouTubeItem[]) || [];
      const nextPageToken = response.nextPageToken as string | undefined;

      client.logger.log('YouTube activities sync completed', {
        connectionId: connection.id,
        activityCount: activities.length,
        hasNextPage: !!nextPageToken,
      });

      return {
        data: { items: activities },
        nextCursor: nextPageToken ? { pageToken: nextPageToken, publishedBefore } : {},
      };
    } else {
      client.logger.log('Performing historical YouTube Likes sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const publishedAfter = (nextCursor.publishedAfter as string) || connection.createdAt.toISOString();

      const params = new URLSearchParams({
        part: 'snippet,contentDetails',
        maxResults: '50',
        mine: 'true',
        publishedAfter,
      });

      if (nextCursor.pageToken) {
        params.set('pageToken', nextCursor.pageToken as string);
      }

      const endpoint = `/youtube/v3/activities?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const activities = (response.items as YouTubeItem[]) || [];
      const nextPageToken = response.nextPageToken as string | undefined;

      client.logger.log('YouTube likes sync completed', {
        connectionId: connection.id,
        activityCount: activities.length,
        hasNextPage: !!nextPageToken,
      });

      return {
        data: { items: activities },
        nextCursor: { publishedAfter: new Date().toISOString() },
      };
    }
  } catch (err) {
    client.logger.error('Error during YouTube Activities sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
