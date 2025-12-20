import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { ContentService } from '@ci/domains/memory';

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
  constructor(
    private readonly contentService: ContentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(YouTubePromotionService.name);
  }

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
        await this.processLikes(data.items, userId);
      } else if (data.type === 'playlists') {
        await this.processPlaylists(data.items, userId);
      } else if (data.type === 'subscriptions') {
        await this.processSubscriptions(data.items, userId);
      } else if (data.type === 'activities') {
        await this.processActivities(data.items, userId);
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

  private async processLikes(items: unknown[], userId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.processLikedVideo(item as YouTubePlaylistItem, userId);
      } catch (error) {
        this.logger.error('Error processing liked video', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async processLikedVideo(item: YouTubePlaylistItem, userId: string): Promise<void> {
    const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    if (!videoId) {
      this.logger.debug('Skipping liked video without id');

      return;
    }

    const title = item.snippet?.title || 'Untitled Video';
    const description = item.snippet?.description || '';
    const channelTitle = item.snippet?.channelTitle || '';
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    await this.contentService.create(
      { userId },
      {
        type: 'youtube_video_like',
        title,
        text: description,
        url,
        mimetype: 'video/youtube',
        external_id: videoId,
        source_url: url,
        user: { id: userId },
      },
    );

    this.logger.log('Processed liked YouTube video', {
      videoId,
      title,
      channelTitle,
    });
  }

  private async processPlaylists(items: unknown[], userId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.processPlaylist(item as YouTubePlaylist, userId);
      } catch (error) {
        this.logger.error('Error processing playlist', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async processPlaylist(item: YouTubePlaylist, userId: string): Promise<void> {
    const playlistId = item.id;
    if (!playlistId) {
      this.logger.debug('Skipping playlist without id');

      return;
    }

    const title = item.snippet?.title || 'Untitled Playlist';
    const description = item.snippet?.description || '';
    const url = `https://www.youtube.com/playlist?list=${playlistId}`;
    const itemCount = item.contentDetails?.itemCount ?? 0;

    await this.contentService.create(
      { userId },
      {
        type: 'youtube_playlist',
        title,
        text: description,
        url,
        external_id: playlistId,
        source_url: url,
        user: { id: userId },
      },
    );

    this.logger.log('Processed YouTube playlist', {
      playlistId,
      title,
      itemCount,
    });
  }

  private async processSubscriptions(items: unknown[], userId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.processSubscription(item as Record<string, unknown>, userId);
      } catch (error) {
        this.logger.error('Error processing subscription', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async processSubscription(item: Record<string, unknown>, userId: string): Promise<void> {
    const snippet = item.snippet as Record<string, unknown> | undefined;
    if (!snippet) {
      this.logger.debug('Skipping subscription without snippet');

      return;
    }

    const channelId = snippet.resourceId
      ? ((snippet.resourceId as Record<string, unknown>).channelId as string)
      : '';
    const channelTitle = (snippet.title as string) || 'Untitled Channel';
    const description = (snippet.description as string) || '';
    const url = channelId ? `https://www.youtube.com/channel/${channelId}` : undefined;

    await this.contentService.create(
      { userId },
      {
        type: 'youtube_subscription',
        title: channelTitle,
        text: description,
        url,
        external_id: channelId || undefined,
        source_url: url,
        user: { id: userId },
      },
    );

    this.logger.log('Processed YouTube subscription', {
      channelId,
      channelTitle,
    });
  }

  private async processActivities(items: unknown[], userId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.processActivity(item as Record<string, unknown>, userId);
      } catch (error) {
        this.logger.error('Error processing activity', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async processActivity(item: Record<string, unknown>, userId: string): Promise<void> {
    const snippet = item.snippet as Record<string, unknown> | undefined;
    const contentDetails = item.contentDetails as Record<string, unknown> | undefined;

    if (!snippet) {
      this.logger.debug('Skipping activity without snippet');

      return;
    }

    const type = snippet.type as string;

    if (type === 'upload' && contentDetails?.upload) {
      const upload = contentDetails.upload as Record<string, unknown>;
      const videoId = upload.videoId as string | undefined;
      const title = (snippet.title as string) || 'Untitled Video';
      const description = (snippet.description as string) || '';
      const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined;

      await this.contentService.create(
        { userId },
        {
          type: 'youtube_activity_upload',
          title,
          text: description,
          url,
          external_id: videoId,
          source_url: url,

          user: { id: userId },
        },
      );

      this.logger.log('Processed YouTube upload activity', {
        videoId,
        title,
      });

      return;
    }

    this.logger.debug('Skipping unsupported YouTube activity', {
      type,
    });
  }
}
