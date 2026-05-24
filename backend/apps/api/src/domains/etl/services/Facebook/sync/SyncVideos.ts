import type { BaseClient, Connection, FacebookVideo } from '@ci/domains/connections';

export async function syncVideos({
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
      client.logger.log('Performing historical Facebook Videos sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const fieldsList =
        'id,title,description,created_time,source,permalink_url,length,thumbnails{uri,height,width}';

      const params = new URLSearchParams({
        type: 'uploaded',
        fields: fieldsList,
      });

      const endpoint = nextCursor.nextLink
        ? String(nextCursor.nextLink)
        : `/v21.0/me/videos?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as {
        data: FacebookVideo[];
        paging?: { next: string; previous: string };
      };
      const videos = response.data || [];
      const nextLink = response.paging?.next;

      client.logger.log('Facebook Videos historical sync call completed', {
        connectionId: connection.id,
        fileCount: videos.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          videos,
        },
        nextCursor: nextLink
          ? {
              nextLink,
            }
          : {},
      };
    } else {
      client.logger.log('Performing incremental Facebook Videos sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const fieldsList =
        'id,title,description,created_time,source,permalink_url,length,thumbnails{uri,height,width}';

      const since = nextCursor.since ? (nextCursor.since as string) : connection.createdAt.toISOString();
      const params = new URLSearchParams({
        type: 'uploaded',
        fields: fieldsList,
        since,
      });

      let videos: FacebookVideo[] = [];
      let nextLink;
      do {
        const endpoint = nextLink ? String(nextLink) : `/v21.0/me/videos?${params.toString()}`;
        const response = (await client.request(connection, endpoint)) as {
          data: FacebookVideo[];
          paging?: { next: string; previous: string };
        };
        videos = videos.concat(response.data || []);
        nextLink = response.paging?.next;
      } while (nextLink != null);

      client.logger.log('Facebook Videos incremental sync call completed', {
        connectionId: connection.id,
        fileCount: videos.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          videos,
        },
        nextCursor: {
          since: new Date().toISOString(),
        },
      };
    }
  } catch (err) {
    client.logger.error('Error during Facebook Videos sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
