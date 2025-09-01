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

    // Dropbox Space Usage
    try {
      const spaceData = await this.request(connection, '/2/users/get_space_usage');

      syncResults.push({ api: 'Dropbox Space Usage', data: spaceData });
    } catch (error) {
      const errorMsg = `Dropbox Space Usage API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox Files - List root folder contents with metadata
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
            include_media_info: true,
            include_deleted: false,
            include_has_explicit_shared_members: true,
            include_mounted_folders: true,
            limit: 100,
          }),
        }
      );

      syncResults.push({ api: 'Dropbox Files', data: filesData });
    } catch (error) {
      const errorMsg = `Dropbox Files API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox File Search - Recent files
    try {
      const searchData = await this.request(
        connection,
        '/2/files/search_v2',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: '',
            options: {
              path: '',
              max_results: 50,
              order_by: {
                '.tag': 'last_modified_time',
                order: 'descending'
              },
              file_status: 'active',
              filename_only: false
            }
          }),
        }
      );

      syncResults.push({ api: 'Dropbox Search', data: searchData });
    } catch (error) {
      const errorMsg = `Dropbox Search API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox Sharing - List shared folders
    try {
      const sharedData = await this.request(
        connection,
        '/2/sharing/list_folders',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            limit: 50,
            actions: []
          }),
        }
      );

      syncResults.push({ api: 'Dropbox Shared Folders', data: sharedData });
    } catch (error) {
      const errorMsg = `Dropbox Shared Folders API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox File Activities - Get recent activity
    try {
      const activityData = await this.request(
        connection,
        '/2/file_requests/list_v2',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            limit: 50
          }),
        }
      );

      syncResults.push({ api: 'Dropbox File Requests', data: activityData });
    } catch (error) {
      const errorMsg = `Dropbox File Requests API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox Paper - List Paper documents
    try {
      const paperData = await this.request(
        connection,
        '/2/paper/docs/list',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filter_by: 'docs_accessed',
            sort_by: 'accessed',
            sort_order: 'descending',
            limit: 50
          }),
        }
      );

      syncResults.push({ api: 'Dropbox Paper', data: paperData });
    } catch (error) {
      const errorMsg = `Dropbox Paper API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox Team Information (if applicable)
    try {
      const teamData = await this.request(
        connection,
        '/2/team/get_info',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }
      );

      syncResults.push({ api: 'Dropbox Team Info', data: teamData });
    } catch (error) {
      const errorMsg = `Dropbox Team Info API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Dropbox Files - Get recent revisions/changes
    try {
      const revisionsData = await this.request(
        connection,
        '/2/files/list_revisions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/recent_changes.txt', // This would need to be dynamic in real usage
            mode: 'path',
            limit: 50
          }),
        }
      );

      syncResults.push({ api: 'Dropbox File Revisions', data: revisionsData });
    } catch (error) {
      // This is expected to fail for most users as it requires a specific file
      // Don't add to errors as it's optional
      this.logger.warn('Dropbox File Revisions API skipped - no specific file provided');
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