import { Injectable } from '@nestjs/common';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import { GraphUtilityService } from '@ci/domains/graph';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { PersonPromotionService } from '../PersonPromotionService';

interface YouTubePlaylistItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: {
      default?: { url?: string };
      medium?: { url?: string };
      high?: { url?: string };
    };
    resourceId?: {
      videoId?: string;
    };
  };
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
  };
}

interface YouTubePlaylist {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: {
      default?: { url?: string };
      medium?: { url?: string };
      high?: { url?: string };
    };
  };
  contentDetails?: {
    itemCount?: number;
  };
}

@Injectable()
export class YouTubePromotionService {
  private logger = new LoggerService(YouTubePromotionService.name);

  constructor(
    private readonly contentService: ContentService,
    private readonly graphUtilityService: GraphUtilityService,
    private readonly personPromotionService: PersonPromotionService,
  ) {}

  async promoteYouTubeData(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Starting YouTube data promotion', {
      userId,
      connectionId,
    });

    try {
      const data = this.extractYouTubeData(apiLogContent);

      if (!data) {
        this.logger.log('No YouTube data found to promote', { userId, connectionId });

        return;
      }

      this.logger.log(`Processing YouTube data: ${data.type}`, {
        userId,
        connectionId,
        type: data.type,
        itemCount: data.items.length,
      });

      if (data.type === 'likes') {
        await this.processLikes(data.items, userId, connectionId);
      } else if (data.type === 'playlists') {
        await this.processPlaylists(data.items, userId, connectionId);
      } else if (data.type === 'subscriptions') {
        await this.processSubscriptions(data.items, userId, connectionId);
      } else if (data.type === 'activities') {
        await this.processActivities(data.items, userId, connectionId);
      }

      this.logger.log('YouTube data promotion completed', {
        userId,
        connectionId,
        type: data.type,
        processedCount: data.items.length,
      });
    } catch (error) {
      this.logger.error('Error promoting YouTube data', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractYouTubeData(content: unknown): {
    type: 'likes' | 'playlists' | 'subscriptions' | 'activities';
    items: unknown[];
  } | null {
    if (!content || typeof content !== 'object') {
      return null;
    }

    const contentObj = content as Record<string, unknown>;

    if ('type' in contentObj && 'items' in contentObj && Array.isArray(contentObj.items)) {
      const type = String(contentObj.type);
      if (type === 'likes' || type === 'playlists' || type === 'subscriptions' || type === 'activities') {
        return { type, items: contentObj.items };
      }
    }

    return null;
  }

  private async processLikes(items: unknown[], userId: string, connectionId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.processLikedVideo(item as YouTubePlaylistItem, userId, connectionId);
      } catch (error) {
        this.logger.error('Error processing liked video', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async processLikedVideo(
    item: YouTubePlaylistItem,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    const title = item.snippet?.title || 'Untitled Video';
    const description = item.snippet?.description || '';
    const channelTitle = item.snippet?.channelTitle || '';
    const channelId = item.snippet?.channelId || '';

    // Get user's entity ID (create if missing)
    const userEntityId = await this.personPromotionService.getUserEntityId(userId);

    // Create video entity
    const videoEntityId = uuid7();
    await this.graphUtilityService.createGraphNode({
      entityId: videoEntityId,
      entityType: 'Video',
      name: title,
      description: `YouTube video by ${channelTitle}`,
      properties: {
        video_id: videoId,
        channel_title: channelTitle,
        channel_id: channelId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        platform: 'youtube',
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url,
        published_at: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt,
        owner_user_id: userId,
      },
      searchContent: `${title} ${channelTitle} ${description}`,
      ownerUserId: userId,
    });

    // Create LIKED relationship
    await this.graphUtilityService.createRelationship(
      userEntityId,
      videoEntityId,
      'LIKED',
      {
        platform: 'youtube',
        connection_id: connectionId,
        liked_at: new Date().toISOString(),
      },
      1.0,
      userId,
    );

    // Save video metadata as content
    const contentDto = {
      id: '',
      type: 'youtube_video',
      title,
      text: description,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      external_id: videoId,
      user: { id: userId },
    };

    await this.contentService.create({ userId }, contentDto as CreateContentDto);

    this.logger.log('Processed liked YouTube video', {
      videoId,
      title,
    });
  }

  private async processPlaylists(items: unknown[], userId: string, connectionId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.processPlaylist(item as YouTubePlaylist, userId, connectionId);
      } catch (error) {
        this.logger.error('Error processing playlist', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async processPlaylist(item: YouTubePlaylist, userId: string, connectionId: string): Promise<void> {
    const playlistId = item.id;
    const title = item.snippet?.title || 'Untitled Playlist';
    const description = item.snippet?.description || '';

    // Get user's entity ID (create if missing)
    const userEntityId = await this.personPromotionService.getUserEntityId(userId);

    // Create playlist entity
    const playlistEntityId = uuid7();
    await this.graphUtilityService.createGraphNode({
      entityId: playlistEntityId,
      entityType: 'Playlist',
      name: title,
      description,
      properties: {
        playlist_id: playlistId,
        url: `https://www.youtube.com/playlist?list=${playlistId}`,
        platform: 'youtube',
        item_count: item.contentDetails?.itemCount || 0,
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url,
        owner_user_id: userId,
      },
      searchContent: `${title} ${description}`,
      ownerUserId: userId,
    });

    // Create CREATED relationship
    await this.graphUtilityService.createRelationship(
      userEntityId,
      playlistEntityId,
      'CREATED',
      {
        platform: 'youtube',
        connection_id: connectionId,
        created_at: item.snippet?.publishedAt || new Date().toISOString(),
      },
      1.0,
      userId,
    );

    this.logger.log('Processed YouTube playlist', {
      playlistId,
      title,
    });
  }

  private async processSubscriptions(items: unknown[], userId: string, connectionId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.processSubscription(item as Record<string, unknown>, userId, connectionId);
      } catch (error) {
        this.logger.error('Error processing subscription', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async processSubscription(
    item: Record<string, unknown>,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    const snippet = item.snippet as Record<string, unknown>;
    const channelId = snippet.resourceId
      ? ((snippet.resourceId as Record<string, unknown>).channelId as string)
      : '';
    const channelTitle = (snippet.title as string) || 'Untitled Channel';
    const description = (snippet.description as string) || '';
    const thumbnail = snippet.thumbnails as Record<string, unknown>;

    // Get user's entity ID (create if missing)
    const userEntityId = await this.personPromotionService.getUserEntityId(userId);

    // Create channel entity
    const channelEntityId = uuid7();
    await this.graphUtilityService.createGraphNode({
      entityId: channelEntityId,
      entityType: 'Channel',
      name: channelTitle,
      description: `YouTube channel: ${channelTitle}`,
      properties: {
        channel_id: channelId,
        url: `https://www.youtube.com/channel/${channelId}`,
        platform: 'youtube',
        thumbnail: thumbnail?.high
          ? (thumbnail.high as Record<string, unknown>).url
          : thumbnail?.default
            ? (thumbnail.default as Record<string, unknown>).url
            : null,
        owner_user_id: userId,
      },
      searchContent: `${channelTitle} ${description}`,
      ownerUserId: userId,
    });

    // Create SUBSCRIBED_TO relationship
    await this.graphUtilityService.createRelationship(
      userEntityId,
      channelEntityId,
      'SUBSCRIBED_TO',
      {
        platform: 'youtube',
        connection_id: connectionId,
        subscribed_at: (snippet.publishedAt as string) || new Date().toISOString(),
      },
      1.0,
      userId,
    );

    this.logger.log('Processed YouTube subscription', {
      channelId,
      channelTitle,
    });
  }

  private async processActivities(items: unknown[], userId: string, connectionId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.processActivity(item as Record<string, unknown>, userId, connectionId);
      } catch (error) {
        this.logger.error('Error processing activity', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async processActivity(
    item: Record<string, unknown>,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    const snippet = item.snippet as Record<string, unknown>;
    const contentDetails = item.contentDetails as Record<string, unknown>;
    const type = snippet.type as string;

    // Get user's entity ID (create if missing)
    const userEntityId = await this.personPromotionService.getUserEntityId(userId);

    // Process based on activity type
    if (type === 'upload' && contentDetails.upload) {
      const upload = contentDetails.upload as Record<string, unknown>;
      const videoId = upload.videoId as string;
      const title = (snippet.title as string) || 'Untitled Video';

      // Create video entity for uploaded video
      const videoEntityId = uuid7();
      await this.graphUtilityService.createGraphNode({
        entityId: videoEntityId,
        entityType: 'Video',
        name: title,
        description: `YouTube video uploaded by user`,
        properties: {
          video_id: videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          platform: 'youtube',
          owner_user_id: userId,
          uploaded_at: snippet.publishedAt as string,
        },
        searchContent: title,
        ownerUserId: userId,
      });

      // Create UPLOADED relationship
      await this.graphUtilityService.createRelationship(
        userEntityId,
        videoEntityId,
        'UPLOADED',
        {
          platform: 'youtube',
          connection_id: connectionId,
          uploaded_at: (snippet.publishedAt as string) || new Date().toISOString(),
        },
        1.0,
        userId,
      );

      this.logger.log('Processed YouTube upload activity', { videoId, title });
    } else if (type === 'comment' && contentDetails.comment) {
      const comment = contentDetails.comment as Record<string, unknown>;
      const resourceId = comment.resourceId as Record<string, unknown>;
      const videoId = resourceId.videoId as string;

      // Log comment activity (we can expand this later to store comments)
      this.logger.log('Processed YouTube comment activity', { videoId, type: 'comment' });
    }
  }
}
