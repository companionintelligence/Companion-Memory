import type {
  BaseClient,
  Connection,
  OutlookAttachment,
  OutlookMailMessageEntity,
} from '@ci/domains/connections';

const MAIL_PAGE_SIZE = 50;

// Default Graph message select does not include internetMessageHeaders.
// The live bulk gate needs List-Unsubscribe / Precedence / Auto-Submitted,
// so the list query must ask for them. $select replaces the default set.
const OUTLOOK_MAIL_SELECT = [
  'id',
  'subject',
  'createdDateTime',
  'lastModifiedDateTime',
  'changeKey',
  'categories',
  'receivedDateTime',
  'sentDateTime',
  'hasAttachments',
  'body',
  'bodyPreview',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'sender',
  'importance',
  'isRead',
  'isDraft',
  'conversationId',
  'internetMessageId',
  'webLink',
  'inferenceClassification',
  'internetMessageHeaders',
].join(',');

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
        `/v1.0/me/messages?%24filter=receivedDateTime%20lt%20${connection.createdAt.toISOString()}%20and%20(body%2fcontent+ne+null%20or%20hasAttachments+eq+true)&=orderBy+receivedDateTime+desc&%24top=${MAIL_PAGE_SIZE}&$select=${OUTLOOK_MAIL_SELECT}`;

      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const messages = (response.value as OutlookMailMessageEntity[]) || [];
      nextLink = response['@odata.nextLink'] as string | undefined;

      for (const message of messages) {
        if (hasMailAttachments(message)) {
          message.attachments = await fetchMailAttachments(connection, client, message.id);
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

      const endpoint = `/v1.0/me/messages?%24filter=receivedDateTime%20gt%20${receivedDateTime}%20and%20(body%2fcontent+ne+null%20or%20hasAttachments+eq+true)&orderBy+receivedDateTime+asc&%24top=${MAIL_PAGE_SIZE}&$select=${OUTLOOK_MAIL_SELECT}`;
      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const messages = (response.value as OutlookMailMessageEntity[]) || [];

      for (const message of messages) {
        if (hasMailAttachments(message)) {
          message.attachments = await fetchMailAttachments(connection, client, message.id);
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

function hasMailAttachments(message: OutlookMailMessageEntity): boolean {
  // Graph's hasAttachments excludes inline-only files. Its message contract
  // directs clients to inspect cid: image references in the HTML body too.
  return message.hasAttachments || /\bsrc\s*=\s*["']?\s*cid:/i.test(message.body?.content ?? '');
}

/**
 * Whether `url` is Graph's own listing of this message's attachments. The path
 * is compared decoded, because Graph may write a message id with a literal `=`
 * where this code writes `%3D`, and both name the same message.
 */
function isAttachmentListOf(messageId: string, url: URL): boolean {
  if (url.origin !== 'https://graph.microsoft.com') {
    return false;
  }

  try {
    return decodeURIComponent(url.pathname).endsWith(`/messages/${messageId}/attachments`);
  } catch {
    // Percent-encoding that does not decode is not a path Graph wrote.
    return false;
  }
}

/** Read every metadata page. Bytes are downloaded during transformation, not queued in Postgres. */
async function fetchMailAttachments(
  connection: Connection,
  client: BaseClient,
  messageId: string,
): Promise<OutlookAttachment[]> {
  const attachments: OutlookAttachment[] = [];
  let endpoint: string | undefined =
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,lastModifiedDateTime,name,contentType,size,isInline&$top=100`;
  const visited = new Set<string>();
  while (endpoint) {
    if (visited.has(endpoint)) {
      throw new Error('Outlook attachment pagination repeated a page');
    }

    visited.add(endpoint);
    const response: { value?: OutlookAttachment[]; '@odata.nextLink'?: string } = await client.request(
      connection,
      endpoint,
    );
    attachments.push(...(response.value ?? []));
    const next = response['@odata.nextLink'];
    if (next) {
      const url = new URL(next, 'https://graph.microsoft.com');
      if (!isAttachmentListOf(messageId, url)) {
        throw new Error('Outlook attachment pagination left the expected provider resource');
      }

      endpoint = url.toString();
    } else {
      endpoint = undefined;
    }
  }

  return attachments;
}
