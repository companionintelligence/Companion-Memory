import {
  type BaseClient,
  type Connection,
  type OneDrivePageEntity,
  type OneDriveFileEntity,
  ONEDRIVE_ETAG_REGEX,
} from '@ci/domains/connections';

const ONEDRIVE_PAGE_SIZE = 50;

export async function syncOneDrive({
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
      client.logger.log('Performing historical OneDrive sync', {
        connectionId: connection.id,
        nextCursor,
      });

      let nextLink: string | undefined = nextCursor?.nextLink ? String(nextCursor.nextLink) : undefined;
      const nextLinkUrl = nextLink ? new URL(nextLink) : null;

      const endpoint = nextLinkUrl
        ? nextLinkUrl.pathname + nextLinkUrl.search + nextLinkUrl.hash
        : `/v1.0/drive/list/items?$filter=contentType%2fname+eq+%27Document%27&$orderby=lastModifiedDateTime%20desc&top=${ONEDRIVE_PAGE_SIZE}`;

      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const files = (response.value as OneDrivePageEntity[]) || [];
      nextLink = response['@odata.nextLink'] as string | undefined;

      const filteredFiles = [];
      for (const file of files) {
        const fileEtag = ONEDRIVE_ETAG_REGEX.exec(file.eTag);
        try {
          file.content = (await client.request(
            connection,
            `/v1.0/drive/items/${fileEtag![1]}`,
          )) as OneDriveFileEntity;
          filteredFiles.push(file);
        } catch (err) {
          console.log('Could not fetch file, skipping', err);
        }
      }

      client.logger.log('Drive historical sync call completed', {
        connectionId: connection.id,
        fileCount: files.length,
        hasNextPage: !!nextLink,
      });

      return {
        data: {
          files,
        },
        nextCursor: nextLink
          ? {
              nextLink: nextLink,
            }
          : {},
      };
    } else {
      client.logger.log('Performing incremental OneDrive sync', {
        connectionId: connection.id,
        nextCursor,
      });

      let deltaLink: string | undefined = nextCursor?.deltaLink ? String(nextCursor.deltaLink) : undefined;
      const deltaLinkUrl = deltaLink ? new URL(deltaLink) : null;

      const params = new URLSearchParams({
        top: String(ONEDRIVE_PAGE_SIZE),
      });

      const endpoint = deltaLinkUrl
        ? deltaLinkUrl.pathname + deltaLinkUrl.search + deltaLinkUrl.hash
        : `/v1.0/me/drive/root/delta?${params.toString()}`;

      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      let files = (response.value as OneDrivePageEntity[]) || [];

      deltaLink = response['@odata.deltaLink'] as string | undefined;

      const filteredFiles = [];
      files = files.filter((file) => file.file && new Date(file.lastModifiedDateTime) > connection.createdAt); // Filter out folders and other non-file items

      for (const file of files) {
        const fileEtag = ONEDRIVE_ETAG_REGEX.exec(file.eTag);
        try {
          file.content = (await client.request(
            connection,
            `/v1.0/drive/items/${fileEtag![1]}`,
          )) as OneDriveFileEntity;
          filteredFiles.push(file);
        } catch (err) {
          console.log('Could not fetch file, skipping', err);
        }
      }

      client.logger.log('Drive incremental sync call completed', {
        connectionId: connection.id,
        fileCount: files.length,
        hasNextPage: !!deltaLink,
      });

      return {
        data: {
          files: filteredFiles,
        },
        nextCursor: deltaLink
          ? {
              deltaLink: deltaLink,
            }
          : {},
      };
    }
  } catch (err) {
    client.logger.error('Error during Drive sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}
