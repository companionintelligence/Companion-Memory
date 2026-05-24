import type {
  BaseClient,
  Connection,
  OutlookAttachment,
  OutlookMailMessageEntity,
} from '@ci/domains/connections';

const MAIL_PAGE_SIZE = 50;

export async function syncOutlookMail({
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
      client.logger.log('Performing historical Outlook Mail sync', {
        connectionId: connection.id,
        nextCursor,
      });

      let nextLink: string | undefined = nextCursor?.nextLink ? String(nextCursor.nextLink) : undefined;

      const endpoint =
        nextLink ||
        `/v1.0/me/messages?%24filter=receivedDateTime%20lt%20${connection.createdAt.toISOString()}%20and%20(body%2fcontent+ne+null%20or%20hasAttachments+eq+true)&=orderBy+receivedDateTime+desc&%24top=${MAIL_PAGE_SIZE}`;

      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const messages = (response.value as OutlookMailMessageEntity[]) || [];
      nextLink = response['@odata.nextLink'] as string | undefined;

      // We could use $expand on the messages call to get attachments, but that will always return the full contentBytes
      // of every attachment, which makes the whole call very slow and the payload very large
      for (const message of messages) {
        if (message.hasAttachments) {
          try {
            message.attachments = (
              (await client.request(
                connection,
                `/v1.0/me/messages/${message.id}/attachments?$select=id,lastModifiedDateTime,name,contentType,size,isInline&top=100`,
              )) as { value: OutlookAttachment[] }
            ).value;
          } catch (err) {
            console.log('Could not fetch attachments, skipping', err);
          }
        }
      }

      client.logger.log('Drive historical sync call completed', {
        connectionId: connection.id,
        messageCount: messages.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          messages,
        },
        nextCursor: nextLink
          ? {
              nextLink: nextLink,
            }
          : {},
      };
    } else {
      client.logger.log('Performing incremental Outlook Mail sync', {
        connectionId: connection.id,
        nextCursor,
      });

      let receivedDateTime: string | undefined = nextCursor?.receivedDateTime
        ? (nextCursor.receivedDateTime as string)
        : undefined;

      if (!receivedDateTime) {
        receivedDateTime = connection.createdAt.toISOString();
      }

      const endpoint = `/v1.0/me/messages?%24filter=receivedDateTime%20gt%20${receivedDateTime}%20and%20(body%2fcontent+ne+null%20or%20hasAttachments+eq+true)&orderBy+receivedDateTime+asc&%24top=${MAIL_PAGE_SIZE}`;
      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const messages = (response.value as OutlookMailMessageEntity[]) || [];

      // We could use $expand on the messages call to get attachments, but that will always return the full contentBytes
      // of every attachment, which makes the whole call very slow and the payload very large
      for (const message of messages) {
        if (message.hasAttachments) {
          try {
            message.attachments = (
              (await client.request(
                connection,
                `/v1.0/me/messages/${message.id}/attachments?$select=id,lastModifiedDateTime,name,contentType,size,isInline&top=100`,
              )) as { value: OutlookAttachment[] }
            ).value;
          } catch (err) {
            console.log('Could not fetch attachments, skipping', err);
          }
        }
      }

      client.logger.log('Drive incremental sync call completed', {
        connectionId: connection.id,
        messageCount: messages.length,
      });

      // Annoyingly, Microsoft's API does not always exactly respect the greater than filter.
      //If there's one message with receivedDateTime 2026-02-18T21:38:25Z, and you use that for filtering with gt,
      //it returns that message on the next call. So the solution is to add one second to the date in order to make
      //sure that message is not returned again.
      return {
        data: {
          messages,
        },
        nextCursor: {
          receivedDateTime:
            messages.length > 0
              ? new Date(new Date(messages[messages.length - 1].receivedDateTime).getTime() + 1000)
              : new Date().toISOString(),
        },
      };
    }
  } catch (err) {
    client.logger.error('Error during Outlook Mail sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
