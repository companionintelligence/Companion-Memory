import type { BaseClient, Connection, GmailMessage } from '@ci/domains/connections';

interface message {
  id: string;
  threadId: string;
}

interface HistoryRecord {
  id: string;
  messages?: message[];
  messagesAdded?: Array<{ message: GmailMessage }>;
  labelsAdded?: Array<{ message: GmailMessage; labelIds?: string[] }>;
}

interface HistoryResponse {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

/**
 * The incremental cursor.
 *
 * - `startHistoryId` — where the next `history.list` starts.
 * - `historyIdAt` — when that id was taken. Only read when Gmail has dropped the history, to
 *   bound the catch-up listing. Cursors written before it existed lack it.
 * - `historyPageToken` + `nextStartHistoryId` — a history walk that has more pages to read. The
 *   start id stays fixed until the last page, and `nextStartHistoryId` (the mailbox's id when the
 *   walk began) becomes the next start, so a change made mid-walk is read again rather than lost.
 * - `catchUp` — Gmail no longer has the history from `startHistoryId`, so the mail in between is
 *   listed with `messages.list` one page per run before history is read again.
 */
interface IncrementalCursor {
  startHistoryId?: string;
  historyIdAt?: string;
  historyPageToken?: string;
  nextStartHistoryId?: string;
  catchUp?: { query?: string; pageToken?: string };
}

/** Mail that never belongs in the record: unsent drafts (one per autosave), spam and trash. */
const SKIPPED_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH']);

/** The labels whose arrival on an existing message (a sent draft, un-archived mail) counts as new mail. */
const ARRIVAL_LABELS = new Set(['INBOX', 'SENT']);

/** How far before `historyIdAt` the catch-up listing starts, so clock skew and slow delivery lose nothing. */
const CATCH_UP_MARGIN_SECONDS = 24 * 60 * 60;

/**
 * Whether `err` is Gmail answering 404 — "Requested entity was not found." `BaseOAuth2Client.request`
 * puts the response body's `code` on `.details`, falling back to the HTTP status.
 */
export function isGmailNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const details = (err as Error & { details?: { code?: number } }).details;

  return details?.code === 404 || /requested entity was not found/i.test(err.message);
}

export async function syncGmail({
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
      client.logger.log('Performing historical Gmail sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const params = new URLSearchParams({
        maxResults: '100',
      });

      let inboxResponse, sentResponse, endpoint;
      let inbox: message[] = [];
      let sent: message[] = [];

      if (nextCursor.inboxPageToken !== false) {
        if (nextCursor.inboxPageToken) {
          params.set('pageToken', nextCursor.inboxPageToken as string);
        }

        endpoint = `/gmail/v1/users/me/messages?${params.toString()}`;

        inboxResponse = (await client.request(connection, endpoint)) as Record<string, unknown>;
        inbox = (inboxResponse.messages as message[]) || [];
      }

      if (nextCursor.sentPageToken !== false) {
        if (nextCursor.sentPageToken) {
          params.set('pageToken', nextCursor.sentPageToken as string);
        } else {
          params.delete('pageToken');
        }

        params.set('labelIds', 'SENT');
        endpoint = `/gmail/v1/users/me/messages?${params.toString()}`;
        sentResponse = (await client.request(connection, endpoint)) as Record<string, unknown>;
        sent = (sentResponse.messages as message[]) || [];
      }

      const messages: GmailMessage[] = [];

      for (const listed of inbox.concat(sent)) {
        const messageDetails = await fetchMessage(connection, client, listed.id);

        if (messageDetails) {
          messages.push(Object.assign(listed, messageDetails));
        }
      }

      const nextInboxPageToken = inboxResponse?.nextPageToken as string | undefined;
      const nextSentPageToken = sentResponse?.nextPageToken as string | undefined;

      client.logger.log('Gmail historical sync call completed', {
        connectionId: connection.id,
        pageMessageCount: messages.length,
        hasNextInboxPage: !!nextInboxPageToken,
        haxNextSentPage: !!nextSentPageToken,
      });

      return {
        data: {
          messages,
        },
        nextCursor:
          nextInboxPageToken || nextSentPageToken
            ? {
                inboxPageToken: nextInboxPageToken || false,
                sentPageToken: nextSentPageToken || false,
              }
            : {},
      };
    }

    return await syncGmailIncremental(connection, client, nextCursor as IncrementalCursor);
  } catch (err) {
    client.logger.error('Error during Gmail sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}

async function syncGmailIncremental(
  connection: Connection,
  client: BaseClient,
  cursor: IncrementalCursor,
): Promise<{ data: Record<string, unknown>; nextCursor: Record<string, unknown> }> {
  client.logger.log('Performing incremental Gmail sync', {
    connectionId: connection.id,
    nextCursor: cursor,
  });

  if (cursor.catchUp) {
    return catchUpPage(connection, client, cursor as IncrementalCursor & { catchUp: object });
  }

  if (!cursor.startHistoryId) {
    // First incremental run: start from now. The historical walk covers everything before it.
    return { data: { messages: [] }, nextCursor: { ...(await currentHistoryPoint(connection, client)) } };
  }

  const params = new URLSearchParams({ maxResults: '100', startHistoryId: cursor.startHistoryId });
  params.append('historyTypes', 'messageAdded');
  params.append('historyTypes', 'labelAdded');

  if (cursor.historyPageToken) {
    params.set('pageToken', cursor.historyPageToken);
  }

  let response: HistoryResponse;

  try {
    response = await client.request<HistoryResponse>(
      connection,
      `/gmail/v1/users/me/history?${params.toString()}`,
    );
  } catch (err) {
    if (!isGmailNotFoundError(err)) {
      throw err;
    }

    // Gmail keeps history for about a week, sometimes only hours, and answers 404 for a start id
    // it no longer has. Thrown, the dead id stayed the last successful cursor and every run failed
    // the same way. Take a fresh history point now, so nothing after this moment is missed, then
    // list the mail in between page by page before reading history again.
    const after = cursor.historyIdAt
      ? Math.floor(new Date(cursor.historyIdAt).getTime() / 1000) - CATCH_UP_MARGIN_SECONDS
      : undefined;

    client.logger.warn('Gmail history expired; listing the missed mail before resuming', {
      connectionId: connection.id,
      startHistoryId: cursor.startHistoryId,
      catchUpAfter: after ?? 'the whole mailbox (the cursor has no timestamp)',
    });

    return {
      data: { messages: [] },
      nextCursor: {
        ...(await currentHistoryPoint(connection, client)),
        catchUp: after !== undefined && Number.isFinite(after) ? { query: `after:${after}` } : {},
      },
    };
  }

  const messages = await fetchNewMessages(connection, client, messageIdsIn(response.history ?? []));
  // The mailbox's id as this walk began; on a later page, the one carried from the first.
  const walkEndId = cursor.nextStartHistoryId ?? response.historyId;

  client.logger.log('Gmail incremental sync call completed', {
    connectionId: connection.id,
    pageMessageCount: messages.length,
    hasNextPage: !!response.nextPageToken,
  });

  if (response.nextPageToken) {
    return {
      data: { messages },
      nextCursor: {
        startHistoryId: cursor.startHistoryId,
        historyIdAt: cursor.historyIdAt,
        historyPageToken: response.nextPageToken,
        nextStartHistoryId: walkEndId,
      },
    };
  }

  return {
    data: { messages },
    nextCursor: walkEndId
      ? { startHistoryId: walkEndId, historyIdAt: new Date().toISOString() }
      : { startHistoryId: cursor.startHistoryId, historyIdAt: cursor.historyIdAt },
  };
}

/** One page of the catch-up listing that follows expired history. */
async function catchUpPage(
  connection: Connection,
  client: BaseClient,
  cursor: IncrementalCursor & { catchUp: { query?: string; pageToken?: string } },
): Promise<{ data: Record<string, unknown>; nextCursor: Record<string, unknown> }> {
  const params = new URLSearchParams({ maxResults: '100' });

  if (cursor.catchUp.query) {
    params.set('q', cursor.catchUp.query);
  }

  if (cursor.catchUp.pageToken) {
    params.set('pageToken', cursor.catchUp.pageToken);
  }

  const response = await client.request<{ messages?: message[]; nextPageToken?: string }>(
    connection,
    `/gmail/v1/users/me/messages?${params.toString()}`,
  );
  const messages = await fetchNewMessages(
    connection,
    client,
    (response.messages ?? []).map((listed) => listed.id),
  );

  client.logger.log('Gmail catch-up page completed', {
    connectionId: connection.id,
    pageMessageCount: messages.length,
    hasNextPage: !!response.nextPageToken,
  });

  const { catchUp, ...rest } = cursor;

  return {
    data: { messages },
    nextCursor: response.nextPageToken
      ? { ...rest, catchUp: { ...catchUp, pageToken: response.nextPageToken } }
      : rest,
  };
}

async function currentHistoryPoint(
  connection: Connection,
  client: BaseClient,
): Promise<{ startHistoryId: string; historyIdAt: string }> {
  const profile = await client.request<{ historyId: string }>(connection, '/gmail/v1/users/me/profile');

  return { startHistoryId: profile.historyId, historyIdAt: new Date().toISOString() };
}

/**
 * Every message a page of history adds, or moves into the inbox or sent mail, once each.
 *
 * A record can carry several messages; reading only the first dropped the rest.
 */
function messageIdsIn(history: HistoryRecord[]): string[] {
  const ids = new Set<string>();

  for (const record of history) {
    for (const added of record.messagesAdded ?? []) {
      if (added.message?.id) {
        ids.add(added.message.id);
      }
    }

    for (const labelled of record.labelsAdded ?? []) {
      if (labelled.message?.id && labelled.labelIds?.some((label) => ARRIVAL_LABELS.has(label))) {
        ids.add(labelled.message.id);
      }
    }
  }

  return [...ids];
}

/** Fetch each message, leaving out ones deleted since, drafts, spam and trash. */
async function fetchNewMessages(
  connection: Connection,
  client: BaseClient,
  ids: string[],
): Promise<GmailMessage[]> {
  const messages: GmailMessage[] = [];

  for (const id of ids) {
    const fetched = await fetchMessage(connection, client, id);

    if (fetched && !fetched.labelIds?.some((label) => SKIPPED_LABELS.has(label))) {
      messages.push(fetched);
    }
  }

  return messages;
}

/**
 * One message in full, or `null` when Gmail no longer has it.
 *
 * History and listings name messages that can be deleted before they are fetched. Thrown, that
 * 404 failed the whole run, and since the cursor never moved, every run after it, forever.
 */
async function fetchMessage(
  connection: Connection,
  client: BaseClient,
  messageId: string,
): Promise<GmailMessage | null> {
  try {
    return await client.request<GmailMessage>(connection, `/gmail/v1/users/me/messages/${messageId}`);
  } catch (err) {
    if (isGmailNotFoundError(err)) {
      client.logger.warn('Gmail message deleted before it could be fetched; skipping it', {
        connectionId: connection.id,
        messageId,
      });

      return null;
    }

    client.logger.error('Error fetching Gmail message', {
      connectionId: connection.id,
      messageId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
