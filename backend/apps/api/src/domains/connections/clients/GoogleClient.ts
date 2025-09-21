import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse } from './types';

export class GoogleClient extends BaseOAuth2Client {
  async sync(connection: Connection, nextPageToken?: string): Promise<SyncResponse> {
    this.logger.log('Syncing Google data', {
      connectionId: connection.id,
      nextPageToken: nextPageToken || 'none',
      isPaginationRequest: !!nextPageToken,
    });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];

    // Google Calendar API - only call this for pagination or initial sync
    try {
      // Build calendar endpoint with proper pagination
      let calendarEndpoint =
        '/calendar/v3/calendars/primary/events?maxResults=250&singleEvents=true&orderBy=startTime';

      // For initial sync, get events from 1 year ago to 1 year in the future
      // For pagination, don't add time filters to get all events
      if (!nextPageToken) {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const oneYearFromNow = new Date();
        oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

        calendarEndpoint += `&timeMin=${oneYearAgo.toISOString()}&timeMax=${oneYearFromNow.toISOString()}`;
      }

      // Add pagination token if provided
      if (nextPageToken) {
        calendarEndpoint += `&pageToken=${nextPageToken}`;
      }

      this.logger.log('Making Google Calendar API request', {
        connectionId: connection.id,
        endpoint: calendarEndpoint,
        nextPageToken: nextPageToken || 'none',
      });

      const calendarData = (await this.request(connection, calendarEndpoint)) as {
        items?: Array<{
          id: string;
          summary?: string;
          description?: string;
          start: { dateTime?: string; date?: string };
          end: { dateTime?: string; date?: string };
          htmlLink?: string;
          [key: string]: unknown;
        }>;
        nextPageToken?: string;
        [key: string]: unknown;
      };

      this.logger.log('Google Calendar API response', {
        connectionId: connection.id,
        hasItems: !!calendarData.items,
        itemCount: calendarData.items?.length || 0,
        hasNextPageToken: !!calendarData.nextPageToken,
        nextPageToken: calendarData.nextPageToken || 'none',
      });

      syncResults.push({
        api: 'Google Calendar',
        data: calendarData,
      });
    } catch (error) {
      const errorMsg = `Google Calendar API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error('Google Calendar API error', {
        connectionId: connection.id,
        error: errorMsg,
        nextPageToken: nextPageToken || 'none',
      });
      errors.push(errorMsg);
    }

    // Only call other APIs on initial sync, not during pagination
    if (!nextPageToken) {
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
