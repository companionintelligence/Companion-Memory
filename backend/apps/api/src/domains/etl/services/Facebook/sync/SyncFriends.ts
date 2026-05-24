import type { BaseClient, Connection, FacebookFriend } from '@ci/domains/connections';

export async function syncFriends({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing historical Facebook Posts sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const fieldsList = 'id,name,picture';

    const params = new URLSearchParams({
      fields: fieldsList,
    });

    const endpoint = nextCursor.nextLink
      ? String(nextCursor.nextLink)
      : `/v21.0/me/friends?${params.toString()}`;
    const response = (await client.request(connection, endpoint)) as {
      data: FacebookFriend[];
      paging?: { next: string; previous: string };
    };
    const friends = response.data || [];
    const nextLink = response.paging?.next;

    client.logger.log('Facebook Friends historical sync call completed', {
      connectionId: connection.id,
      fileCount: friends.length,
      hasNextPage: !!nextLink,
    });

    return {
      data: {
        friends,
      },
      nextCursor: nextLink
        ? {
            nextLink,
          }
        : {},
    };
  } catch (err) {
    client.logger.error('Error during Facebook Videos sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
