import type { BaseClient, Connection, FacebookPost } from '@ci/domains/connections';

export async function syncPosts({
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
      client.logger.log('Performing historical Drive sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const fieldsList =
        'id,message,created_time,story,link,type,full_picture,picture,attachments{media,subattachments}';

      const params = new URLSearchParams({
        fields: fieldsList,
      });

      const endpoint = nextCursor.nextLink
        ? String(nextCursor.nextLink)
        : `/v21.0/me/posts?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as {
        data: FacebookPost[];
        paging?: { next: string; previous: string };
      };
      const posts = response.data || [];
      const nextLink = response.paging?.next;

      client.logger.log('Facebook Posts historical sync call completed', {
        connectionId: connection.id,
        fileCount: posts.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          posts,
        },
        nextCursor: nextLink
          ? {
              nextLink,
            }
          : {},
      };
    } else {
      client.logger.log('Performing incremental Facebook Posts sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const fieldsList =
        'id,message,created_time,story,link,type,full_picture,picture,attachments{media,subattachments}';

      const since = nextCursor.since ? (nextCursor.since as string) : connection.createdAt.toISOString();
      const params = new URLSearchParams({
        fields: fieldsList,
        since,
      });

      let posts: FacebookPost[] = [];
      let nextLink;
      do {
        const endpoint = nextLink ? String(nextLink) : `/v21.0/me/posts?${params.toString()}`;
        const response = (await client.request(connection, endpoint)) as {
          data: FacebookPost[];
          paging?: { next: string; previous: string };
        };
        posts = posts.concat(response.data || []);
        nextLink = response.paging?.next;
      } while (nextLink != null);

      client.logger.log('Facebook Posts Incremental sync call completed', {
        connectionId: connection.id,
        fileCount: posts.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          posts,
        },
        nextCursor: {
          since: new Date().toISOString(),
        },
      };
    }
  } catch (err) {
    client.logger.error('Error during Facebook Posts sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
