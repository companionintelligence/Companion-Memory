import type { BaseClient, Connection, FacebookLike } from '@ci/domains/connections';

export async function syncLikes({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing historical Facebook Likes sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const fieldsList = 'id,name,category,link,created_time,cover';

    const params = new URLSearchParams({
      fields: fieldsList,
    });

    // `/me/likes` — the Pages this user has liked. This used to request
    // `/me/posts` with like-shaped fields, so every "like" it stored was
    // actually one of the user's own posts under the wrong content type, and
    // real likes were never fetched.
    const endpoint = nextCursor.nextLink
      ? String(nextCursor.nextLink)
      : `/v21.0/me/likes?${params.toString()}`;
    const response = (await client.request(connection, endpoint)) as {
      data: FacebookLike[];
      paging?: { next: string; previous: string };
    };
    const likes = response.data || [];
    const nextLink = response.paging?.next;

    client.logger.log('Facebook Likes historical sync call completed', {
      connectionId: connection.id,
      fileCount: likes.length,
      hasNextPage: !!nextLink,
    });

    return {
      data: {
        likes,
      },
      nextCursor: nextLink
        ? {
            nextLink,
          }
        : {},
    };
  } catch (err) {
    client.logger.error('Error during Facebook Likes sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
