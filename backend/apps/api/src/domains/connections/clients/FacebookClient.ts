import type { FacebookSyncState } from '@ci/domains/etl';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResponse } from './types';

export class FacebookClient extends BaseOAuth2Client {
  protected readonly baseUrl = 'https://graph.facebook.com';

  protected readonly authorizationEndpoint = 'https://www.facebook.com/v21.0/dialog/oauth';

  protected readonly tokenEndpoint = 'https://graph.facebook.com/v21.0/oauth/access_token';

  // Facebook permissions based on what you configured
  protected readonly scopes = [
    'email',
    'public_profile',
    'user_age_range',
    'user_birthday',
    'user_friends',
    'user_gender',
    'user_hometown',
    'user_likes',
    'user_link',
    'user_location',
    'user_photos',
    'user_posts',
    'user_videos',
  ];

  protected get clientId() {
    const clientIdVariable = 'FACEBOOK_CLIENT_ID';
    const clientId = process.env[clientIdVariable];

    if (!clientId) {
      this.logger.error(`Expected environment variable ${clientIdVariable} not specified`);

      throw new Error('Client id not configured for provider');
    }

    return clientId;
  }

  protected get clientSecret() {
    const clientSecretVariable = 'FACEBOOK_CLIENT_SECRET';
    const clientSecret = process.env[clientSecretVariable];

    if (!clientSecret) {
      this.logger.error(`Expected environment variable ${clientSecretVariable} not specified`);

      throw new Error('Client secret not configured for provider');
    }

    return clientSecret;
  }

  /**
   * Get user's basic profile information
   */
  private async fetchProfile(connection: Connection) {
    try {
      const fields = [
        'id',
        'name',
        'email',
        'age_range',
        'birthday',
        'gender',
        'hometown',
        'link',
        'location',
      ].join(',');

      const profile = await this.request<{
        id: string;
        name: string;
        email?: string;
        age_range?: { min: number; max?: number };
        birthday?: string;
        gender?: string;
        hometown?: { id: string; name: string };
        link?: string;
        location?: { id: string; name: string };
      }>(connection, `/v21.0/me?fields=${fields}`);

      return profile;
    } catch (error) {
      this.logger.error('Failed to fetch Facebook profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Fetch user's posts with pagination
   */
  private async fetchPosts(connection: Connection, syncState: FacebookSyncState['posts'] | null) {
    try {
      const url =
        syncState?.nextUrl ||
        '/v21.0/me/posts?fields=id,message,created_time,story,link,type,full_picture,picture,attachments{media,subattachments}';

      const response = await this.request<{
        data: Array<{
          id: string;
          message?: string;
          created_time: string;
          story?: string;
          link?: string;
          type: string;
          full_picture?: string;
          picture?: string;
          attachments?: {
            data: Array<{
              media?: {
                image?: { src: string };
                video?: { source: string };
              };
              subattachments?: {
                data: Array<{
                  media?: {
                    image?: { src: string };
                    video?: { source: string };
                  };
                }>;
              };
            }>;
          };
        }>;
        paging?: {
          next?: string;
          previous?: string;
        };
      }>(connection, url);

      const newSyncState: FacebookSyncState['posts'] = {
        nextUrl: response.paging?.next,
        since: response.data[0]?.created_time || syncState?.since,
      };

      return {
        data: response.data,
        syncState: newSyncState,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Facebook posts', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Fetch user's photos with pagination
   */
  private async fetchPhotos(connection: Connection, syncState: FacebookSyncState['photos'] | null) {
    try {
      const url =
        syncState?.nextUrl ||
        '/v21.0/me/photos?type=uploaded&fields=id,name,created_time,images,link,picture,place';

      const response = await this.request<{
        data: Array<{
          id: string;
          name?: string;
          created_time: string;
          images?: Array<{ height: number; width: number; source: string }>;
          link?: string;
          picture?: string;
        }>;
        paging?: {
          next?: string;
          previous?: string;
        };
      }>(connection, url);

      const newSyncState: FacebookSyncState['photos'] = {
        nextUrl: response.paging?.next,
        since: response.data[0]?.created_time || syncState?.since,
      };

      return {
        data: response.data,
        syncState: newSyncState,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Facebook photos', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Fetch user's videos with pagination
   */
  private async fetchVideos(connection: Connection, syncState: FacebookSyncState['videos'] | null) {
    try {
      const url =
        syncState?.nextUrl ||
        '/v21.0/me/videos?type=uploaded&fields=id,title,description,created_time,source,permalink_url';

      const response = await this.request<{
        data: Array<{
          id: string;
          title?: string;
          description?: string;
          created_time: string;
          source?: string;
          permalink_url?: string;
        }>;
        paging?: {
          next?: string;
          previous?: string;
        };
      }>(connection, url);

      const newSyncState: FacebookSyncState['videos'] = {
        nextUrl: response.paging?.next,
        since: response.data[0]?.created_time || syncState?.since,
      };

      return {
        data: response.data,
        syncState: newSyncState,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Facebook videos', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Fetch user's friends
   */
  private async fetchFriends(connection: Connection, syncState: FacebookSyncState['friends'] | null) {
    try {
      const url = syncState?.nextUrl || '/v21.0/me/friends?fields=id,name,picture';

      const response = await this.request<{
        data: Array<{
          id: string;
          name: string;
          picture?: {
            data: {
              url: string;
            };
          };
        }>;
        paging?: {
          next?: string;
        };
        summary?: {
          total_count: number;
        };
      }>(connection, url);

      const newSyncState: FacebookSyncState['friends'] = {
        nextUrl: response.paging?.next,
      };

      return {
        data: response.data,
        syncState: newSyncState,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Facebook friends', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Fetch user's likes (pages they like)
   */
  private async fetchLikes(connection: Connection, syncState: FacebookSyncState['likes'] | null) {
    try {
      const url = syncState?.nextUrl || '/v21.0/me/likes?fields=id,name,category,link';

      const response = await this.request<{
        data: Array<{
          id: string;
          name: string;
          category?: string;
          link?: string;
        }>;
        paging?: {
          next?: string;
        };
      }>(connection, url);

      const newSyncState: FacebookSyncState['likes'] = {
        nextUrl: response.paging?.next,
      };

      return {
        data: response.data,
        syncState: newSyncState,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Facebook likes', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Main sync method that orchestrates all Facebook data syncing
   */
  async sync(connection: Connection): Promise<SyncResponse[]> {
    const responses: SyncResponse[] = [];

    try {
      const syncState = (connection.syncState as FacebookSyncState) || {};

      // Fetch profile
      try {
        const profile = await this.fetchProfile(connection);

        responses.push({
          success: true,
          message: 'Facebook profile sync completed successfully',
          data: {
            results: [
              {
                api: 'facebook profile',
                data: profile,
                syncState: {},
              },
            ],
            errors: [],
          },
        });
      } catch (error) {
        this.logger.warn('Failed to sync Facebook profile', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        responses.push({
          success: false,
          message: `Facebook profile sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          data: {
            results: [],
            errors: [`facebook.profile: ${error instanceof Error ? error.message : 'Unknown error'}`],
          },
        });
      }

      // Fetch posts
      try {
        const posts = await this.fetchPosts(connection, syncState.posts || null);

        responses.push({
          success: true,
          message: 'Facebook posts sync completed successfully',
          data: {
            results: [
              {
                api: 'facebook posts',
                data: posts.data,
                syncState: posts.syncState,
              },
            ],
            errors: [],
          },
          cursor: { posts: posts.syncState },
        });
      } catch (error) {
        this.logger.warn('Failed to sync Facebook posts', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        responses.push({
          success: false,
          message: `Facebook posts sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          data: {
            results: [],
            errors: [`facebook posts: ${error instanceof Error ? error.message : 'Unknown error'}`],
          },
        });
      }

      // Fetch photos
      try {
        const photos = await this.fetchPhotos(connection, syncState.photos || null);

        responses.push({
          success: true,
          message: 'Facebook photos sync completed successfully',
          data: {
            results: [
              {
                api: 'facebook photos',
                data: photos.data,
                syncState: photos.syncState,
              },
            ],
            errors: [],
          },
          cursor: { photos: photos.syncState },
        });
      } catch (error) {
        this.logger.warn('Failed to sync Facebook photos', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        responses.push({
          success: false,
          message: `Facebook photos sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          data: {
            results: [],
            errors: [`facebook.photos: ${error instanceof Error ? error.message : 'Unknown error'}`],
          },
        });
      }

      // Fetch videos
      try {
        const videos = await this.fetchVideos(connection, syncState.videos || null);

        responses.push({
          success: true,
          message: 'Facebook videos sync completed successfully',
          data: {
            results: [
              {
                api: 'facebook videos',
                data: videos.data,
                syncState: videos.syncState,
              },
            ],
            errors: [],
          },
          cursor: { videos: videos.syncState },
        });
      } catch (error) {
        this.logger.warn('Failed to sync Facebook videos', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        responses.push({
          success: false,
          message: `Facebook videos sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          data: {
            results: [],
            errors: [`facebook.videos: ${error instanceof Error ? error.message : 'Unknown error'}`],
          },
        });
      }

      // Fetch friends
      try {
        const friends = await this.fetchFriends(connection, syncState.friends || null);

        responses.push({
          success: true,
          message: 'Facebook friends sync completed successfully',
          data: {
            results: [
              {
                api: 'facebook friends',
                data: friends.data,
                syncState: friends.syncState,
              },
            ],
            errors: [],
          },
          cursor: { friends: friends.syncState },
        });
      } catch (error) {
        this.logger.warn('Failed to sync Facebook friends', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        responses.push({
          success: false,
          message: `Facebook friends sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          data: {
            results: [],
            errors: [`facebook friends: ${error instanceof Error ? error.message : 'Unknown error'}`],
          },
        });
      }

      // Fetch likes
      try {
        const likes = await this.fetchLikes(connection, syncState.likes || null);

        responses.push({
          success: true,
          message: 'Facebook likes sync completed successfully',
          data: {
            results: [
              {
                api: 'facebook likes',
                data: likes.data,
                syncState: likes.syncState,
              },
            ],
            errors: [],
          },
          cursor: { likes: likes.syncState },
        });
      } catch (error) {
        this.logger.warn('Failed to sync Facebook likes', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        responses.push({
          success: false,
          message: `Facebook likes sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          data: {
            results: [],
            errors: [`facebook.likes: ${error instanceof Error ? error.message : 'Unknown error'}`],
          },
        });
      }

      return responses;
    } catch (error) {
      this.logger.error('Facebook sync failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        connectionId: connection.id,
      });

      return [
        {
          success: false,
          message: `Facebook sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          data: {
            results: [],
            errors: [`facebook: ${error instanceof Error ? error.message : 'Unknown error'}`],
          },
        },
      ];
    }
  }
}
