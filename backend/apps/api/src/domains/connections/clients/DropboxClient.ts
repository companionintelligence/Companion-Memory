import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse } from './types';

export class DropboxClient extends BaseOAuth2Client {
  async sync(connection: Connection): Promise<SyncResponse> {
    this.logger.log('Syncing Dropbox data', { connectionId: connection.id });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];

    // Dropbox Current Account Info
    try {
      const accountData = await this.request(connection, '/2/users/get_current_account');

      syncResults.push({
        api: 'Dropbox Account',
        data: accountData,
      });
    } catch (error) {
      const errorMsg = `Dropbox Account API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox Files - List folder contents
    try {
      const filesData = await this.request(
        connection,
        '/2/files/list_folder',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '',
            recursive: false,
            include_media_info: false,
            include_deleted: false,
            include_has_explicit_shared_members: false,
            include_mounted_folders: false,
            limit: 10,
          }),
        }
      );

      syncResults.push({ api: 'Dropbox Files', data: filesData });
    } catch (error) {
      const errorMsg = `Dropbox Files API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox Space Usage
    try {
      const spaceData = await this.request(connection, '/2/users/get_space_usage');

      syncResults.push({ api: 'Dropbox Space Usage', data: spaceData });
    } catch (error) {
      const errorMsg = `Dropbox Space Usage API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    return {
      success: errors.length === 0,
      message: `Sync completed. ${syncResults.length} APIs processed successfully. ${errors.length} errors occurred.`,
      data: {
        results: syncResults,
        errors,
      },
    };
  }
}