import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse } from './types';

export class MetaClient extends BaseOAuth2Client {
  /**
   * Downloads media file from a URL and returns file information
   */
  private async downloadMediaFile(
    url: string,
    filename: string,
    connectionId: string,
  ): Promise<{ url: string; filename: string; size?: number; error?: string }> {
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        return {
          url,
          filename,
          error: `Failed to download: ${response.statusText}`,
        };
      }
      
      // Get content length if available
      const contentLength = response.headers.get('content-length');
      const size = contentLength ? parseInt(contentLength, 10) : undefined;
      
      // For now, we'll return the metadata. In a full implementation, 
      // we would save to S3/Minio here using FileService
      this.logger.log(`Media file metadata extracted: ${filename}`, { 
        connectionId, 
        url: url.substring(0, 100) + '...', 
        size 
      });
      
      return {
        url,
        filename,
        size,
      };
    } catch (error) {
      return {
        url,
        filename,
        error: error instanceof Error ? error.message : 'Unknown download error',
      };
    }
  }

  /**
   * Extracts media URLs and downloads them from API response data
   */
  private async processMediaInResponse(
    responseData: any,
    connectionId: string,
    mediaType: 'photo' | 'video' | 'media',
  ): Promise<any[]> {
    if (!responseData || typeof responseData !== 'object') {
      return [];
    }
    
    const dataArray = Array.isArray(responseData) ? responseData : 
                     (responseData.data && Array.isArray(responseData.data) ? responseData.data : []);
    
    const processedItems = [];
    
    for (const item of dataArray) {
      if (!item || typeof item !== 'object') {
        processedItems.push(item);
        continue;
      }
      
      const processedItem = { ...item };
      const downloadedMedia = [];
      
      // Extract media URLs based on type and API structure
      const mediaUrls = [];
      
      if (mediaType === 'photo') {
        // Facebook photos API
        if (item.picture) mediaUrls.push({ url: item.picture, type: 'image', field: 'picture' });
        if (item.source) mediaUrls.push({ url: item.source, type: 'image', field: 'source' });
        // Instagram photos
        if (item.images?.standard_resolution?.url) {
          mediaUrls.push({ url: item.images.standard_resolution.url, type: 'image', field: 'standard_resolution' });
        }
        if (item.images?.low_resolution?.url) {
          mediaUrls.push({ url: item.images.low_resolution.url, type: 'image', field: 'low_resolution' });
        }
        if (item.images?.thumbnail?.url) {
          mediaUrls.push({ url: item.images.thumbnail.url, type: 'image', field: 'thumbnail' });
        }
      } else if (mediaType === 'video') {
        // Facebook videos API  
        if (item.source) mediaUrls.push({ url: item.source, type: 'video', field: 'source' });
        // Instagram videos
        if (item.videos?.standard_resolution?.url) {
          mediaUrls.push({ url: item.videos.standard_resolution.url, type: 'video', field: 'standard_resolution' });
        }
        if (item.videos?.low_resolution?.url) {
          mediaUrls.push({ url: item.videos.low_resolution.url, type: 'video', field: 'low_resolution' });
        }
      } else if (mediaType === 'media') {
        // Instagram mixed media
        if (item.type === 'image') {
          if (item.images?.standard_resolution?.url) {
            mediaUrls.push({ url: item.images.standard_resolution.url, type: 'image', field: 'standard_resolution' });
          }
          if (item.images?.thumbnail?.url) {
            mediaUrls.push({ url: item.images.thumbnail.url, type: 'image', field: 'thumbnail' });
          }
        } else if (item.type === 'video') {
          if (item.videos?.standard_resolution?.url) {
            mediaUrls.push({ url: item.videos.standard_resolution.url, type: 'video', field: 'standard_resolution' });
          }
        }
      }
      
      // Download each media file
      for (const media of mediaUrls) {
        const filename = `${item.id || 'unknown'}_${media.field}.${media.type === 'image' ? 'jpg' : 'mp4'}`;
        const downloadResult = await this.downloadMediaFile(media.url, filename, connectionId);
        downloadedMedia.push(downloadResult);
      }
      
      if (downloadedMedia.length > 0) {
        processedItem._downloadedMedia = downloadedMedia;
      }
      
      processedItems.push(processedItem);
    }
    
    return processedItems;
  }

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

    // Facebook Graph API - User Photos (with media download)
    try {
      const userPhotos = await this.request(
        connection,
        '/me/photos?limit=10&fields=id,name,picture,source,created_time,width,height',
      );

      // Process and download photo media
      const processedPhotos = await this.processMediaInResponse(userPhotos, connection.id, 'photo');

      syncResults.push({
        api: 'Facebook Graph - Photos',
        data: { ...userPhotos, data: processedPhotos },
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

    // Facebook Graph API - Albums (with photos download)
    try {
      const userAlbums = await this.request(
        connection,
        '/me/albums?limit=10&fields=id,name,description,created_time,count,cover_photo',
      );

      // Fetch photos from each album and download media
      let processedAlbums = [];
      if (
        userAlbums &&
        typeof userAlbums === 'object' &&
        'data' in userAlbums &&
        Array.isArray((userAlbums as { data: unknown[] }).data)
      ) {
        const albumData = (userAlbums as { data: { id: string }[] }).data;
        for (const album of albumData.slice(0, 5)) { // Limit to 5 albums to avoid too many requests
          try {
            const albumPhotos = await this.request(
              connection,
              `/${album.id}/photos?limit=5&fields=id,picture,source,created_time`,
            );
            
            // Download photos from this album
            const processedPhotos = await this.processMediaInResponse(albumPhotos, connection.id, 'photo');
            
            processedAlbums.push({
              ...album,
              photos: processedPhotos,
            });
          } catch {
            // Individual album photo fetch failures shouldn't break the whole sync
            processedAlbums.push({
              ...album,
              photos: [],
            });
          }
        }
      }

      syncResults.push({
        api: 'Facebook Graph - Albums',
        data: { ...userAlbums, data: processedAlbums },
      });
    } catch (error) {
      const errorMsg = `Facebook Albums API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Videos (with media download)
    try {
      const userVideos = await this.request(
        connection,
        '/me/videos?limit=10&fields=id,title,description,created_time,source,thumbnails',
      );

      // Process and download video media
      const processedVideos = await this.processMediaInResponse(userVideos, connection.id, 'video');

      syncResults.push({
        api: 'Facebook Graph - Videos',
        data: { ...userVideos, data: processedVideos },
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

    // Instagram API - User Media (with media download)
    try {
      const instagramMedia = await this.request(connection, '/v1/users/self/media/recent?count=10');

      // Process and download media
      const processedMedia = await this.processMediaInResponse(instagramMedia, connection.id, 'media');

      syncResults.push({
        api: 'Instagram - Media',
        data: { ...instagramMedia, data: processedMedia },
      });
    } catch (error) {
      const errorMsg = `Instagram Media API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Instagram API - User Media with Comments (with media download)
    try {
      const instagramMediaComments = await this.request(connection, '/v1/users/self/media/recent?count=5');

      // If we have media items, fetch comments for each and download media
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
            const mediaWithCommentsItem = {
              ...media,
              comments:
                comments && typeof comments === 'object' && 'data' in comments
                  ? (comments as { data: unknown[] }).data
                  : [],
            };
            
            // Download media for this item
            const processedMediaItems = await this.processMediaInResponse([mediaWithCommentsItem], connection.id, 'media');
            mediaWithComments.push(processedMediaItems[0]);
          } catch {
            // Individual comment fetch failures shouldn't break the whole sync
            const mediaItem = { ...media, comments: [] };
            const processedMediaItems = await this.processMediaInResponse([mediaItem], connection.id, 'media');
            mediaWithComments.push(processedMediaItems[0]);
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

    // Instagram API - User Liked Media (with media download)
    try {
      const instagramLiked = await this.request(connection, '/v1/users/self/media/liked?count=10');

      // Process and download liked media
      const processedLikedMedia = await this.processMediaInResponse(instagramLiked, connection.id, 'media');

      syncResults.push({
        api: 'Instagram - Liked Media',
        data: { ...instagramLiked, data: processedLikedMedia },
      });
    } catch (error) {
      const errorMsg = `Instagram Liked Media API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Groups
    try {
      const userGroups = await this.request(
        connection,
        '/me/groups?limit=10&fields=id,name,description,privacy,member_count',
      );

      syncResults.push({
        api: 'Facebook Graph - Groups',
        data: userGroups,
      });
    } catch (error) {
      const errorMsg = `Facebook Groups API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Friends
    try {
      const userFriends = await this.request(
        connection,
        '/me/friends?limit=10&fields=id,name',
      );

      syncResults.push({
        api: 'Facebook Graph - Friends',
        data: userFriends,
      });
    } catch (error) {
      const errorMsg = `Facebook Friends API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - Tagged Places/Check-ins
    try {
      const taggedPlaces = await this.request(
        connection,
        '/me/tagged_places?limit=10&fields=id,name,place,created_time',
      );

      syncResults.push({
        api: 'Facebook Graph - Tagged Places',
        data: taggedPlaces,
      });
    } catch (error) {
      const errorMsg = `Facebook Tagged Places API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - User's Owned Applications
    try {
      const userApps = await this.request(
        connection,
        '/me/applications/developer?limit=10&fields=id,name,category',
      );

      syncResults.push({
        api: 'Facebook Graph - Applications',
        data: userApps,
      });
    } catch (error) {
      const errorMsg = `Facebook Applications API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - User's Books
    try {
      const userBooks = await this.request(
        connection,
        '/me/books?limit=10&fields=id,name,category',
      );

      syncResults.push({
        api: 'Facebook Graph - Books',
        data: userBooks,
      });
    } catch (error) {
      const errorMsg = `Facebook Books API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - User's Movies
    try {
      const userMovies = await this.request(
        connection,
        '/me/movies?limit=10&fields=id,name,category',
      );

      syncResults.push({
        api: 'Facebook Graph - Movies',
        data: userMovies,
      });
    } catch (error) {
      const errorMsg = `Facebook Movies API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - User's Music
    try {
      const userMusic = await this.request(
        connection,
        '/me/music?limit=10&fields=id,name,category',
      );

      syncResults.push({
        api: 'Facebook Graph - Music',
        data: userMusic,
      });
    } catch (error) {
      const errorMsg = `Facebook Music API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Facebook Graph API - User's Television
    try {
      const userTV = await this.request(
        connection,
        '/me/television?limit=10&fields=id,name,category',
      );

      syncResults.push({
        api: 'Facebook Graph - Television',
        data: userTV,
      });
    } catch (error) {
      const errorMsg = `Facebook Television API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

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
