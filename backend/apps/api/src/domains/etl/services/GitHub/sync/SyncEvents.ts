import type { BaseClient, Connection } from '@ci/domains/connections';

export async function syncEvents({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}) {
  try {
    client.logger.log('Performing GitHub Events sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const externalId = connection.externalId;

    if (!externalId) {
      throw new Error('GitHub user ID not found on connection');
    }

    const page = nextCursor?.page ? Number(nextCursor.page) : 1;
    const endpoint = `/users/${externalId}/events?per_page=100&page=${page}`;

    const response = await client.request<unknown[]>(connection, endpoint);

    const events = response || [];

    client.logger.log('GitHub Events sync call completed', {
      connectionId: connection.id,
      eventCount: events.length,
      page,
      hasNextPage: events.length === 100,
    });

    return {
      data: {
        events,
      },
      nextCursor:
        events.length === 100
          ? {
              page: page + 1,
            }
          : {},
    };
  } catch (err) {
    client.logger.error('Failed to sync GitHub Events', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}

