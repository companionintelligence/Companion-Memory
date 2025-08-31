import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse } from './types';

export class MetaClient extends BaseOAuth2Client {
  async sync(connection: Connection): Promise<SyncResponse> {
    this.logger.log('Syncing Meta data', { connectionId: connection.id });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];

    // Facebook Graph API - User Profile
    try {
      const userProfile = await this.request(connection, '/me?fields=id,name,email');

      syncResults.push({
        api: 'Facebook Graph - Profile',
        data: userProfile,
      });
    } catch (error) {
      const errorMsg = `Facebook Profile API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - User Feed
    try {
      const userFeed = await this.request(connection, '/me/feed?limit=10&fields=id,message,created_time,type');

      syncResults.push({
        api: 'Facebook Graph - Feed',
        data: userFeed,
      });
    } catch (error) {
      const errorMsg = `Facebook Feed API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - User Photos
    try {
      const userPhotos = await this.request(connection, '/me/photos?limit=10&fields=id,name,picture,created_time');

      syncResults.push({
        api: 'Facebook Graph - Photos',
        data: userPhotos,
      });
    } catch (error) {
      const errorMsg = `Facebook Photos API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Instagram API - User Profile
    try {
      const instagramProfile = await this.request(connection, '/v1/users/self');

      syncResults.push({
        api: 'Instagram - Profile',
        data: instagramProfile,
      });
    } catch (error) {
      const errorMsg = `Instagram Profile API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Instagram API - User Media
    try {
      const instagramMedia = await this.request(connection, '/v1/users/self/media/recent?count=10');

      syncResults.push({
        api: 'Instagram - Media',
        data: instagramMedia,
      });
    } catch (error) {
      const errorMsg = `Instagram Media API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

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