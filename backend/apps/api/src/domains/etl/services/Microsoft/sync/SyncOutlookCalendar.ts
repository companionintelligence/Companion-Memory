import type {
  BaseClient,
  Connection,
  Calendar,
  CalendarEvent,
  OutlookAttachment,
} from '@ci/domains/connections';

const CALENDAR_PAGE_SIZE = 50;

export async function syncOutlookCalendar({
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
      client.logger.log('Performing historical Outlook Calendar sync', {
        connectionId: connection.id,
        nextCursor,
      });

      let nextLink: string | undefined = nextCursor?.nextLink ? String(nextCursor.nextLink) : undefined;

      const endpoint = nextLink || `/v1.0/me/calendars?top=${CALENDAR_PAGE_SIZE}`;

      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const calendars = (response.value as Calendar[]) || [];
      nextLink = response['@odata.nextLink'] as string | undefined;

      for (const calendar of calendars) {
        client.logger.log('Performing Outlook Calendar sync for', {
          connectionId: connection.id,
          calendarId: calendar.id,
        });

        let nextPageLink;
        const calendarEvents = [];

        // Get all calendars first
        do {
          const endpoint =
            nextPageLink || `/v1.0/me/calendars/${calendar.id}/events?top=${CALENDAR_PAGE_SIZE}`;

          let response;
          try {
            response = (await client.request(connection, endpoint)) as Record<string, unknown>;
          } catch (e) {
            console.error('Error fetching calendars', e);
            throw e;
          }

          const events = (response.value as CalendarEvent[]) || [];
          nextPageLink = response['@odata.nextLink'] as string | undefined;

          for (const event of events) {
            if (event.hasAttachments) {
              try {
                event.attachments = (
                  (await client.request(
                    connection,
                    `/v1.0/me/calendars/${calendar.id}/events/${event.id}/attachments?$select=id,lastModifiedDateTime,name,contentType,size,isInline&top=100`,
                  )) as { value: OutlookAttachment[] }
                ).value;
              } catch (err) {
                console.log('Could not fetch attachments, skipping', err);
              }
            }
          }

          client.logger.log('Calendar events full sync page completed', {
            connectionId: connection.id,
            hasNextPage: !!nextPageLink,
          });

          calendarEvents.push(...events);
        } while (nextPageLink);

        calendar.events = calendarEvents;
      }

      client.logger.log('Outlook Calendar historical sync call completed', {
        connectionId: connection.id,
        calendarCount: calendars.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          calendars,
        },
        nextCursor: nextLink
          ? {
              nextLink: nextLink,
            }
          : {},
      };
    } else {
      client.logger.log('Performing incremental Outlook Calendar sync', {
        connectionId: connection.id,
        nextCursor,
      });

      let nextCalendarsLink: string | undefined;
      let calendars: Array<Calendar> = [];

      do {
        const endpoint = nextCalendarsLink || `/v1.0/me/calendars?top=${CALENDAR_PAGE_SIZE}`;

        let response;
        try {
          response = (await client.request(connection, endpoint)) as Record<string, unknown>;
        } catch (e) {
          console.error('Error fetching calendars', e);
          throw e;
        }

        if (response.value) {
          calendars = calendars.concat(response.value as Calendar[]);
        }

        nextCalendarsLink = response['@odata.nextLink'] as string | undefined;
      } while (nextCalendarsLink);

      const nextDeltaLinks: Record<string, string> = {};

      for (const calendar of calendars) {
        client.logger.log('Performing Outlook Calendar sync for', {
          connectionId: connection.id,
          calendarId: calendar.id,
        });

        let nextDeltaLink: string | undefined =
          nextCursor.deltaLinks && (nextCursor.deltaLinks as Record<string, string>)[calendar.id]
            ? (nextCursor.deltaLinks as Record<string, string>)[calendar.id]
            : undefined;

        const params = new URLSearchParams({
          startDateTime: new Date().toISOString(),
          endDateTime: new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString(), // 3 years in the future
        });

        const endpoint =
          nextDeltaLink || `/v1.0/me/calendars/${calendar.id}/calendarView/delta?${params.toString()}`;

        let response;
        try {
          response = (await client.request(connection, endpoint)) as Record<string, unknown>;
        } catch (e) {
          console.error('Error fetching calendars', e);
          throw e;
        }

        const events = (response.value as CalendarEvent[]) || [];

        for (const event of events) {
          if (event.hasAttachments) {
            try {
              event.attachments = (
                (await client.request(
                  connection,
                  `/v1.0/me/calendars/${calendar.id}/events/${event.id}/attachments?$select=id,lastModifiedDateTime,name,contentType,size,isInline&top=100`,
                )) as { value: OutlookAttachment[] }
              ).value;
            } catch (err) {
              console.log('Could not fetch attachments, skipping', err);
            }
          }
        }

        calendar.events = events;
        nextDeltaLink = response['@odata.deltaLink'] as string;

        nextDeltaLinks[calendar.id] = nextDeltaLink;

        client.logger.log('Calendar events full sync page completed', {
          connectionId: connection.id,
          hasNextPage: !!nextDeltaLink,
        });
      }

      client.logger.log('Outlook Calendar incremental sync call completed', {
        connectionId: connection.id,
        calendarLength: calendars.length,
      });

      return {
        data: {
          calendars,
        },
        nextCursor: {
          deltaLinks: nextDeltaLinks,
        },
      };
    }
  } catch (err) {
    client.logger.error('Error during Outlook Calendar sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
