import type { BaseClient, Connection } from '@ci/domains/connections';

interface Contact {
  resourceName: string;
  names?: Array<Record<string, unknown>>;
  emailAddresses?: Array<Record<string, unknown>>;
  phoneNumbers?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export async function syncContacts({
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
    client.logger.log('Performing incremental Google Contacts sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const personFields = [
      'names',
      'emailAddresses',
      'phoneNumbers',
      'addresses',
      'organizations',
      'occupations',
      'relations',
      'nicknames',
      'birthdays',
      'urls',
      'photos',
      'imClients',
      'locales',
      'locations',
      'interests',
      'skills',
      'sipAddresses',
      'miscKeywords',
      'ageRanges',
      'genders',
      'metadata',
    ].join(',');

    const params = new URLSearchParams({
      pageSize: '1000',
      personFields,
      requestSyncToken: 'true',
    });

    if (nextCursor.syncToken) {
      params.set('syncToken', nextCursor.syncToken as string);
    }

    if (nextCursor.pageToken) {
      params.set('pageToken', nextCursor.pageToken as string);
    }

    const endpoint = `https://people.googleapis.com/v1/people/me/connections?${params.toString()}`;
    const response = (await client.request(connection, endpoint)) as {
      connections?: Contact[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };

    const connections = (response.connections as unknown[]) || [];
    const nextPageToken = response.nextPageToken as string | undefined;
    const nextSyncToken = response.nextSyncToken as string | undefined;

    client.logger.log('YouTube likes sync completed', {
      connectionId: connection.id,
      contactCount: connections.length,
      hasNextPage: !!nextPageToken,
      hasNextSyncToken: !!nextSyncToken,
    });

    return {
      data: { contacts: connections },
      nextCursor: nextSyncToken
        ? { syncToken: nextSyncToken }
        : nextPageToken
          ? { pageToken: nextPageToken }
          : {},
    };
  } catch (err) {
    client.logger.error('Error during Contacts sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
