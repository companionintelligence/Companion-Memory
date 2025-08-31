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
      const userFeed = await this.request(
        connection,
        '/me/feed?limit=10&fields=id,message,created_time,type',
      );

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
      const userPhotos = await this.request(
        connection,
        '/me/photos?limit=10&fields=id,name,picture,created_time',
      );

      syncResults.push({
        api: 'Facebook Graph - Photos',
        data: userPhotos,
      });
    } catch (error) {
      const errorMsg = `Facebook Photos API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Events
    try {
      const userEvents = await this.request(
        connection,
        '/me/events?limit=10&fields=id,name,start_time,end_time,place,description',
      );

      syncResults.push({
        api: 'Facebook Graph - Events',
        data: userEvents,
      });
    } catch (error) {
      const errorMsg = `Facebook Events API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Likes
    try {
      const userLikes = await this.request(
        connection,
        '/me/likes?limit=10&fields=id,name,category,created_time',
      );

      syncResults.push({
        api: 'Facebook Graph - Likes',
        data: userLikes,
      });
    } catch (error) {
      const errorMsg = `Facebook Likes API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Albums
    try {
      const userAlbums = await this.request(
        connection,
        '/me/albums?limit=10&fields=id,name,description,created_time,count',
      );

      syncResults.push({
        api: 'Facebook Graph - Albums',
        data: userAlbums,
      });
    } catch (error) {
      const errorMsg = `Facebook Albums API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Videos
    try {
      const userVideos = await this.request(
        connection,
        '/me/videos?limit=10&fields=id,title,description,created_time,source',
      );

      syncResults.push({
        api: 'Facebook Graph - Videos',
        data: userVideos,
      });
    } catch (error) {
      const errorMsg = `Facebook Videos API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Posts with Comments
    try {
      const userPosts = await this.request(
        connection,
        '/me/posts?limit=10&fields=id,message,created_time,comments{id,message,created_time,from}',
      );

      syncResults.push({
        api: 'Facebook Graph - Posts with Comments',
        data: userPosts,
      });
    } catch (error) {
      const errorMsg = `Facebook Posts with Comments API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Pages (if user manages any)
    try {
      const userPages = await this.request(
        connection,
        '/me/accounts?limit=10&fields=id,name,category,access_token',
      );

      syncResults.push({
        api: 'Facebook Graph - Pages',
        data: userPages,
      });
    } catch (error) {
      const errorMsg = `Facebook Pages API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Conversations/Messages (requires special permissions)
    try {
      const conversations = await this.request(
        connection,
        '/me/conversations?limit=10&fields=id,updated_time,message_count',
      );

      syncResults.push({
        api: 'Facebook Graph - Messages',
        data: conversations,
      });
    } catch (error) {
      const errorMsg = `Facebook Messages API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

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

    // Instagram API - User Media with Comments
    try {
      const instagramMediaComments = await this.request(connection, '/v1/users/self/media/recent?count=5');

      // If we have media items, fetch comments for each
      if (
        instagramMediaComments &&
        typeof instagramMediaComments === 'object' &&
        'data' in instagramMediaComments &&
        Array.isArray((instagramMediaComments as { data: unknown[] }).data) &&
        (instagramMediaComments as { data: unknown[] }).data.length > 0
      ) {
        const mediaWithComments = [];
        const mediaData = (instagramMediaComments as { data: { id: string }[] }).data;
        for (const media of mediaData.slice(0, 3)) {
          // Limit to 3 items to avoid too many requests
          try {
            const comments = await this.request(connection, `/v1/media/${media.id}/comments`);
            mediaWithComments.push({
              ...media,
              comments:
                comments && typeof comments === 'object' && 'data' in comments
                  ? (comments as { data: unknown[] }).data
                  : [],
            });
          } catch {
            // Individual comment fetch failures shouldn't break the whole sync
            mediaWithComments.push({
              ...media,
              comments: [],
            });
          }
        }

        syncResults.push({
          api: 'Instagram - Media with Comments',
          data: { data: mediaWithComments },
        });
      }
    } catch (error) {
      const errorMsg = `Instagram Media with Comments API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Instagram API - User Liked Media
    try {
      const instagramLiked = await this.request(connection, '/v1/users/self/media/liked?count=10');

      syncResults.push({
        api: 'Instagram - Liked Media',
        data: instagramLiked,
      });
    } catch (error) {
      const errorMsg = `Instagram Liked Media API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

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
