import type { BaseClient, Connection } from '@ci/domains/connections';

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  [key: string]: unknown;
}

interface DriveChange {
  fileId: string;
  file?: DriveFile;
  removed?: boolean;
  [key: string]: unknown;
}

export async function syncDrive({
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
      client.logger.log('Performing historical Drive sync', {
        connectionId: connection.id,
        nextCursor,
      });

      const fieldsList =
        'nextPageToken,files(id,name,mimeType,modifiedTime,owners,iconLink,webViewLink,size)';

      const params = new URLSearchParams({
        pageSize: '200',
        fields: fieldsList,
        q: 'trashed=false',
        orderBy: 'modifiedTime desc',
      });

      if (nextCursor.pageToken) {
        params.set('pageToken', nextCursor.pageToken as string);
      }

      const endpoint = `/drive/v3/files?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const files = (response.files as DriveFile[]) || [];
      const nextPageToken = response.nextPageToken as string | undefined;

      client.logger.log('Drive historical sync call completed', {
        connectionId: connection.id,
        fileCount: files.length,
        hasNextPage: !!nextPageToken,
      });

      return {
        data: {
          files,
        },
        nextCursor: nextPageToken
          ? {
              pageToken: nextPageToken,
            }
          : {},
      };
    } else {
      client.logger.log('Performing incremental Drive sync', {
        connectionId: connection.id,
        nextCursor,
      });

      let startPageToken = nextCursor.startPageToken as string | undefined;

      if (!nextCursor.startPageToken) {
        const tokenResp = (await client.request(connection, `/drive/v3/changes/startPageToken`)) as Record<
          string,
          unknown
        >;
        startPageToken = String(tokenResp.startPageToken || '');
      }

      const fieldsChanges =
        'nextPageToken,newStartPageToken,changes(file(id,name,mimeType,modifiedTime,owners,iconLink,webViewLink,size),fileId,removed)';

      const params = new URLSearchParams({
        pageSize: '200',
        includeRemoved: 'true',
        restrictToMyDrive: 'true',
        fields: fieldsChanges,
        pageToken: String(startPageToken),
      });

      const endpoint = `/drive/v3/changes?${params.toString()}`;
      const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
      const changes = (response.changes as DriveChange[]) || [];
      const nextPageToken = response.nextPageToken as string | undefined;
      const newStartPageToken = response.newStartPageToken as string | undefined;

      const changedFiles = changes
        .filter((c) => c.file && c.removed !== true)
        .map((c) => c.file) as DriveFile[];

      client.logger.log('Drive incremental sync call completed', {
        connectionId: connection.id,
        changeCount: changes.length,
        fileCount: changedFiles.length,
        hasNextPage: !!nextPageToken,
      });

      return {
        data: {
          files: changedFiles,
        },
        nextCursor: {
          startPageToken: newStartPageToken || nextPageToken || nextCursor.startPageToken,
        },
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
