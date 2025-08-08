import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse } from './types';

export class GoogleClient extends BaseOAuth2Client {
  async sync(connection: Connection): Promise<SyncResponse> {
    this.logger.log('Syncing Google data', { connectionId: connection.id });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];

    // Google Calendar API
    try {
      const calendarData = await this.request(
        connection,
        '/calendar/v3/calendars/primary/events?maxResults=10&timeMin=' + new Date().toISOString(),
      );

      syncResults.push({
        api: 'Google Calendar',
        data: calendarData,
      });
    } catch (error) {
      const errorMsg = `Google Calendar API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Gmail API
    try {
      const gmailData = await this.request(connection, '/gmail/v1/users/me/messages?maxResults=10');

      syncResults.push({ api: 'Gmail', data: gmailData });
    } catch (error) {
      const errorMsg = `Gmail API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Google Drive API
    try {
      const driveData = await this.request(connection, '/drive/v3/files?pageSize=10');

      syncResults.push({ api: 'Google Drive', data: driveData });
    } catch (error) {
      const errorMsg = `Google Drive API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

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
