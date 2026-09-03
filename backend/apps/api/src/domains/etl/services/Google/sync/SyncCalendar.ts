import type { BaseClient, Connection } from '@ci/domains/connections';

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: Record<string, unknown>;
  end?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Whether `err` is Google's 410 GONE response for an invalidated sync token
 * (`reason: 'fullSyncRequired'`). `BaseOAuth2Client.request` throws an `Error`
 * whose `.details` carries `{ code, message }` parsed from the response body
 * — Google's Calendar API puts the HTTP status in `error.code` there — and
 * falls back to `{ code: response.status, message: response.statusText }`
 * when the body can't be parsed as JSON; either way `details.code` ends up as
 * the HTTP status. The message check is a fallback for any shape that misses.
 */
function isSyncTokenInvalidError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const details = (err as Error & { details?: { code?: number } }).details;

  if (details?.code === 410) {
    return true;
  }

  return /sync\s*token|fullsyncrequired|\b410\b/i.test(err.message);
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
        // Masters + genuine RFC 5545 overrides, NOT per-occurrence expansion:
        // the ICS importer keeps one row per series master, and identity
        // converges only when both pipelines represent a series the same way
        // (docs/design/cross-pipeline-identity.md). singleEvents=true minted
        // one `uid#instant` row per occurrence and duplicated every recurring
        // series against its imported master.
        singleEvents: 'false',
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
        // Masters + overrides only — see the historical branch above.
        singleEvents: 'false',
      });

      const usedSyncToken = !!nextCursor.syncToken;

      if (nextCursor.syncToken) {
        params.set('syncToken', nextCursor.syncToken as string);
      } else if (nextCursor.pageToken) {
        params.set('pageToken', nextCursor.pageToken as string);
        params.set('timeMin', connection.createdAt.toISOString());
      }

      const endpoint = `/calendar/v3/calendars/primary/events?${params.toString()}`;

      let response: Record<string, unknown>;

      try {
        response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      } catch (err) {
        if (usedSyncToken && isSyncTokenInvalidError(err)) {
          // Google invalidates a sync token whose request parameters changed
          // (e.g. the singleEvents=false switch above) and answers 410 GONE
          // (fullSyncRequired). SyncOrchestrator.orchestrateIncremental only
          // ever carries forward the LAST SUCCESSFUL job's nextCursor, so
          // letting this propagate as a failure would leave that dead token
          // as the "latest success" forever — every future tick re-mints the
          // same job, hits the same 410, and never recovers. Clear the
          // cursor and report a benign empty success instead: the next
          // incremental job runs token-less (same shape as an endpoint's
          // very first sync) and comes back with a fresh syncToken to build
          // on.
          client.logger.warn('Calendar syncToken invalidated by provider; clearing cursor for full resync', {
            connectionId: connection.id,
            error: err instanceof Error ? err.message : 'Unknown error',
          });

          return {
            data: { items: [] },
            nextCursor: {},
          };
        }

        throw err;
      }

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
