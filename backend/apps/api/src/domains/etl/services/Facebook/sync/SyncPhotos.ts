import type { BaseClient, Connection, FacebookPhoto } from '@ci/domains/connections';

export async function syncPhotos({
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
      client.logger.log('Performing historical Facebook Photos sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const fieldsList = 'id,name,created_time,images,link,picture,place';

      const params = new URLSearchParams({
        type: 'uploaded',
        fields: fieldsList,
      });

      const endpoint = nextCursor.nextLink
        ? String(nextCursor.nextLink)
        : `/v21.0/me/photos?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as {
        data: FacebookPhoto[];
        paging?: { next: string; previous: string };
      };
      const photos = response.data || [];
      const nextLink = response.paging?.next;

      client.logger.log('Facebook Photos historical sync call completed', {
        connectionId: connection.id,
        fileCount: photos.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          photos,
        },
        nextCursor: nextLink
          ? {
              nextLink,
            }
          : {},
      };
    } else {
      client.logger.log('Performing incremental Facebook Photos sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const fieldsList = 'id,name,created_time,images,link,picture,place';

      const since = nextCursor.since ? (nextCursor.since as string) : connection.createdAt.toISOString();
      const params = new URLSearchParams({
        type: 'uploaded',
        fields: fieldsList,
        since,
      });

      let photos: FacebookPhoto[] = [];
      let nextLink;
      do {
        const endpoint = nextLink ? String(nextLink) : `/v21.0/me/photos?${params.toString()}`;
        const response = (await client.request(connection, endpoint)) as {
          data: FacebookPhoto[];
          paging?: { next: string; previous: string };
        };
        photos = photos.concat(response.data || []);
        nextLink = response.paging?.next;
      } while (nextLink != null);

      client.logger.log('Facebook Photos incremental sync call completed', {
        connectionId: connection.id,
        fileCount: photos.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          photos,
        },
        nextCursor: {
          since: new Date().toISOString(),
        },
      };
    }
  } catch (err) {
    client.logger.error('Error during Facebook Photos sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
