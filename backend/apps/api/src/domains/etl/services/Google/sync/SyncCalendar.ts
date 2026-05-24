import type { BaseClient, Connection } from '@ci/domains/connections';

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: Record<string, unknown>;
  end?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function syncCalendar({
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
      client.logger.log('Performing historical Calendar sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const params = new URLSearchParams({
        maxResults: '200',
        showDeleted: 'true',
        singleEvents: 'true',
        timeMax: connection.createdAt.toISOString(),
      });

      if (nextCursor.pageToken) {
        params.set('pageToken', nextCursor.pageToken as string);
      }

      const endpoint = `/calendar/v3/calendars/primary/events?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const events = (response.items as CalendarEvent[]) || [];
      const nextPageToken = response.nextPageToken as string | undefined;
      const nextSyncToken = response.nextSyncToken as string | undefined;

      client.logger.log('Calendar historical sync call completed', {
        connectionId: connection.id,
        eventCount: events.length,
        hasNextPage: !!nextPageToken,
        hasSyncToken: !!nextSyncToken,
      });

      return {
        data: {
          items: events,
        },
        nextCursor: nextPageToken ? { pageToken: nextPageToken } : {},
      };
    } else {
      client.logger.log('Performing incremental Calendar sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const params = new URLSearchParams({
        maxResults: '200',
        showDeleted: 'true',
        singleEvents: 'true',
      });

      if (nextCursor.syncToken) {
        params.set('syncToken', nextCursor.syncToken as string);
      } else if (nextCursor.pageToken) {
        params.set('pageToken', nextCursor.pageToken as string);
        params.set('timeMin', connection.createdAt.toISOString());
      }

      const endpoint = `/calendar/v3/calendars/primary/events?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const events = (response.items as CalendarEvent[]) || [];
      const nextPageToken = response.nextPageToken as string | undefined;
      const nextSyncToken = response.nextSyncToken as string | undefined;

      client.logger.log('Calendar incremental sync call completed', {
        connectionId: connection.id,
        eventCount: events.length,
      });

      return {
        data: {
          items: events,
        },
        nextCursor: nextSyncToken
          ? {
              syncToken: nextSyncToken,
            }
          : nextPageToken
            ? {
                pageToken: nextPageToken,
              }
            : {},
      };
    }
  } catch (err) {
    client.logger.error('Error during Calendar sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
