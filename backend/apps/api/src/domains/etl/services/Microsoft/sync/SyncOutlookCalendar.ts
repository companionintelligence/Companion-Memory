import type {
  BaseClient,
  Connection,
  Calendar,
  CalendarEvent,
  CalendarViewWindow,
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

/** How far ahead a fresh delta round reaches: three years. */
const DELTA_WINDOW_MS = 3 * 365 * 24 * 60 * 60 * 1000;

/**
 * The request that starts a calendar's delta round — the next three years of
 * its events — and that range, which every later link of the round inherits.
 */
function initialDeltaRound(calendarId: string): { endpoint: string; window: CalendarViewWindow } {
  const start = new Date();
  const window = {
    startDateTime: start.toISOString(),
    endDateTime: new Date(start.getTime() + DELTA_WINDOW_MS).toISOString(),
  };

  return {
    endpoint: `/v1.0/me/calendars/${calendarId}/calendarView/delta?${new URLSearchParams(window).toString()}`,
    window,
  };
}

function isCalendarViewWindow(value: unknown): value is CalendarViewWindow {
  const window = value as Partial<CalendarViewWindow> | null;

  return (
    typeof window?.startDateTime === 'string' &&
    typeof window.endDateTime === 'string' &&
    !Number.isNaN(Date.parse(window.startDateTime)) &&
    !Number.isNaN(Date.parse(window.endDateTime))
  );
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
 *
 * `window` is the round's date range. A stored link is followed only together
 * with the range stored beside it: Graph's links are opaque, and the transform
 * cannot read the round's `@removed` entries without the range (see
 * TransformOutlookCalendar). A link stored before ranges were recorded starts a
 * fresh round instead, once.
 */
async function walkDeltaRound({
  connection,
  client,
  calendarId,
  stored,
}: {
  connection: Connection;
  client: BaseClient;
  calendarId: string;
  stored: { link: string; window: CalendarViewWindow } | undefined;
}): Promise<{
  events: CalendarEvent[];
  resumeLink: string | undefined;
  window: CalendarViewWindow;
  roundComplete: boolean;
  pages: number;
}> {
  const { endpoint: firstEndpoint, window } = stored
    ? { endpoint: stored.link, window: stored.window }
    : initialDeltaRound(calendarId);
  const events: CalendarEvent[] = [];
  // What to persist if no response gives a better link: the one this run
  // started from, so a malformed answer re-asks rather than forgets the round.
  let resumeLink = stored?.link;
  let roundComplete = false;
  let pages = 0;
  let endpoint: string | undefined = firstEndpoint;

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

  return { events, resumeLink, window, roundComplete, pages };
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

      // Per calendar, the link the next run resumes from — the `@odata.deltaLink`
      // of a completed round, or the `@odata.nextLink` of one cut short — and
      // beside it the date range of the round that link belongs to.
      const nextDeltaLinks: Record<string, string> = {};
      const nextDeltaWindows: Record<string, CalendarViewWindow> = {};
      const storedDeltaLinks = (nextCursor?.deltaLinks ?? {}) as Record<string, unknown>;
      const storedDeltaWindows = (nextCursor?.deltaWindows ?? {}) as Record<string, unknown>;

      for (const calendar of calendars) {
        client.logger.log('Performing Outlook Calendar sync for', {
          connectionId: connection.id,
          calendarId: calendar.id,
        });

        const storedLink = storedDeltaLinks[calendar.id];
        const storedWindow = storedDeltaWindows[calendar.id];
        const hasStoredLink = typeof storedLink === 'string' && storedLink.length > 0;

        if (hasStoredLink && !isCalendarViewWindow(storedWindow)) {
          client.logger.log('Restarting Outlook Calendar delta round stored without its date range', {
            connectionId: connection.id,
            calendarId: calendar.id,
          });
        }

        const { events, resumeLink, window, roundComplete, pages } = await walkDeltaRound({
          connection,
          client,
          calendarId: calendar.id,
          stored:
            hasStoredLink && isCalendarViewWindow(storedWindow)
              ? { link: storedLink, window: storedWindow }
              : undefined,
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
        calendar.deltaWindow = window;

        if (resumeLink) {
          nextDeltaLinks[calendar.id] = resumeLink;
          nextDeltaWindows[calendar.id] = window;
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
          deltaWindows: nextDeltaWindows,
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
