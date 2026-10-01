import type {
  BaseClient,
  Connection,
  Calendar,
  CalendarEvent,
  OutlookAttachment,
} from '@ci/domains/connections';

const CALENDAR_PAGE_SIZE = 50;

/**
 * Events one run takes from one calendar's delta round before it stops and
 * leaves the rest to the next run, which resumes from the cursor.
 *
 * Draining a round is unbounded work: the first round of a calendar is every
 * occurrence of every series over the next three years, each carrying its full
 * body, and it all lands in a single sync job's `data` and then in the
 * transform. This cap keeps that payload bounded. It is checked after each
 * page, so a run can overshoot it by up to one page.
 */
export const MAX_DELTA_EVENTS_PER_RUN = 500;

/** The request that starts a calendar's first delta round: the next three years of its events. */
function initialDeltaEndpoint(calendarId: string): string {
  const params = new URLSearchParams({
    startDateTime: new Date().toISOString(),
    endDateTime: new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString(), // 3 years in the future
  });

  return `/v1.0/me/calendars/${calendarId}/calendarView/delta?${params.toString()}`;
}

/**
 * Walk one calendar's `calendarView/delta` round from `storedLink` (or from a
 * fresh round when there is none) until Graph ends it.
 *
 * Every delta response carries exactly one of two links. An `@odata.nextLink`
 * means the round has more pages, "even if the current response contains an
 * empty result"; an `@odata.deltaLink` means the round is complete and is where
 * the NEXT round starts. A page never carries both
 * (https://learn.microsoft.com/en-us/graph/delta-query-overview).
 *
 * `resumeLink` is whichever of the two the last response gave, and it is what
 * the caller must persist. This used to read a single page and persist only its
 * `@odata.deltaLink`, so a round spanning pages saved nothing: the page read
 * carried a nextLink, the stored link came out `undefined` (and was dropped on
 * the way into the jsonb cursor), and every run restarted the round, importing
 * the same first page again and never reaching the rest.
 *
 * The walk also stops once {@link MAX_DELTA_EVENTS_PER_RUN} events are in hand,
 * in which case `resumeLink` is the nextLink to carry on from.
 */
async function walkDeltaRound({
  connection,
  client,
  calendarId,
  storedLink,
}: {
  connection: Connection;
  client: BaseClient;
  calendarId: string;
  storedLink: string | undefined;
}): Promise<{
  events: CalendarEvent[];
  resumeLink: string | undefined;
  roundComplete: boolean;
  pages: number;
}> {
  const events: CalendarEvent[] = [];
  // What to persist if no response gives a better link: the one this run
  // started from, so a malformed answer re-asks rather than forgets the round.
  let resumeLink = storedLink;
  let roundComplete = false;
  let pages = 0;
  let endpoint: string | undefined = storedLink ?? initialDeltaEndpoint(calendarId);

  while (endpoint) {
    let response: Record<string, unknown>;

    try {
      response = (await client.request(connection, endpoint)) as Record<string, unknown>;
    } catch (err) {
      client.logger.error('Error fetching Outlook Calendar delta page', {
        connectionId: connection.id,
        calendarId,
        error: err instanceof Error ? err.message : 'Unknown error',
        details: (err as { details?: unknown } | null)?.details,
      });
      throw err;
    }

    pages += 1;
    events.push(...((response.value as CalendarEvent[]) || []));

    const deltaLink = response['@odata.deltaLink'] as string | undefined;
    const nextLink = response['@odata.nextLink'] as string | undefined;

    if (deltaLink) {
      resumeLink = deltaLink;
      roundComplete = true;
      endpoint = undefined;
    } else if (nextLink) {
      resumeLink = nextLink;
      endpoint = events.length < MAX_DELTA_EVENTS_PER_RUN ? nextLink : undefined;
    } else {
      client.logger.warn('Outlook Calendar delta response carried neither a nextLink nor a deltaLink', {
        connectionId: connection.id,
        calendarId,
      });
      endpoint = undefined;
    }
  }

  return { events, resumeLink, roundComplete, pages };
}

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

      // Per calendar, the link the next run resumes from: the `@odata.deltaLink`
      // of a completed round, or the `@odata.nextLink` of one cut short.
      const nextDeltaLinks: Record<string, string> = {};
      const storedDeltaLinks = (nextCursor?.deltaLinks ?? {}) as Record<string, unknown>;

      for (const calendar of calendars) {
        client.logger.log('Performing Outlook Calendar sync for', {
          connectionId: connection.id,
          calendarId: calendar.id,
        });

        const storedLink = storedDeltaLinks[calendar.id];

        const { events, resumeLink, roundComplete, pages } = await walkDeltaRound({
          connection,
          client,
          calendarId: calendar.id,
          storedLink: typeof storedLink === 'string' && storedLink ? storedLink : undefined,
        });

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

        if (resumeLink) {
          nextDeltaLinks[calendar.id] = resumeLink;
        }

        client.logger.log('Calendar delta sync completed', {
          connectionId: connection.id,
          calendarId: calendar.id,
          pages,
          eventCount: events.length,
          roundComplete,
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
