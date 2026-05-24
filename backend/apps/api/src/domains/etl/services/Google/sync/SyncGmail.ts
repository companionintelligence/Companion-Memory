import type { BaseClient, Connection, GmailMessage } from '@ci/domains/connections';

interface message {
  id: string;
  threadId: string;
}

interface historyMessage {
  id: string;
  messages: message[];
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

      const messages = inbox.concat(sent);

      for (const message of messages) {
        const messageDetails = await fetchMessage(connection, client, message.id);
        Object.assign(message, messageDetails);
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
    } else {
      client.logger.log('Performing incremental Gmail sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const params = new URLSearchParams({
        maxResults: '100',
        labelId: 'INBOX',
      });

      if (nextCursor.startHistoryId) {
        params.set('startHistoryId', nextCursor.startHistoryId as string);
      } else {
        const profile = (await client.request(connection, '/gmail/v1/users/me/profile')) as Record<
          string,
          unknown
        >;
        params.set('startHistoryId', profile.historyId as string);
      }

      const inboxEndpoint = `/gmail/v1/users/me/history?${params.toString()}`;
      const inboxResponse = (await client.request(connection, inboxEndpoint)) as Record<string, unknown>;
      const inbox = (inboxResponse.history as historyMessage[]) || [];

      params.set('labelId', 'SENT');
      const sentEndpoint = `/gmail/v1/users/me/history?${params.toString()}`;
      const sentResponse = (await client.request(connection, sentEndpoint)) as Record<string, unknown>;
      const sent = (sentResponse.history as historyMessage[]) || [];

      const messages = inbox.concat(sent);

      for (const message of messages) {
        const messageDetails = await fetchMessage(connection, client, message.messages[0].id);
        Object.assign(message, messageDetails);
      }

      client.logger.log('Gmail incremental sync call completed', {
        connectionId: connection.id,
        pageMessageCount: messages.length,
      });

      return {
        data: {
          messages,
        },
        nextCursor: {
          startHistoryId: inboxResponse.historyId as string, //Will use the same historyId for inbox and sent
        },
      };
    }
  } catch (err) {
    client.logger.error('Error during Gmail sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}

async function fetchMessage(
  connection: Connection,
  client: BaseClient,
  messageId: string,
): Promise<GmailMessage> {
  try {
    return (await client.request(connection, `/gmail/v1/users/me/messages/${messageId}`)) as GmailMessage;
  } catch (err) {
    client.logger.error('Error fetching Gmail message', {
      connectionId: connection.id,
      messageId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
