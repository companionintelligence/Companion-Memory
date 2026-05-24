import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
interface FacebookLike {
  id: string;
  name: string;
  category?: string;
  link?: string;
}
@Injectable()
export class FacebookLikesTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookLikesTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;
    this.logger.log('Starting Facebook likes transformation', {
      userId,
      connectionId: connection.id,
    });
    try {
      const likes = this.extractLikes(data);
      if (likes.length === 0) {
        this.logger.log('No Facebook likes found to transform', { userId, connectionId: connection.id });

        return;
      }

      for (const like of likes) {
        try {
          // Search for existing content by external_id
          const existingContent = await this.contentService.search({ userId }, { external_id: like.id });

          if (existingContent.length > 0) {
            // Update existing content
            const existingItem = existingContent[0];
            await this.contentService.update({ userId }, existingItem.id, {
              type: 'Content',
              title: like.name,
              text: like.category ? `Category: ${like.category}` : '',
              url: like.link || undefined,
              mimetype: 'text/plain',
              external_id: like.id,
              source_url: like.link || undefined,
              source_data: {
                facebook_like_id: like.id,
                category: like.category,
                connection_id: connection.id,
                contentType: 'facebook_like',
              },
            });
            this.logger.log('Updated existing Facebook like content', {
              likeId: like.id,
              contentId: existingItem.id,
            });
          } else {
            // Create new content
            const contentDto = {
              id: uuidv7(),
              type: 'Content',
              title: like.name,
              text: like.category ? `Category: ${like.category}` : '',
              url: like.link || undefined,
              mimetype: 'text/plain',
              external_id: like.id,
              source_url: like.link || undefined,
              source_data: {
                facebook_like_id: like.id,
                category: like.category,
                connection_id: connection.id,
                contentType: 'facebook_like',
              },
              user: { id: userId },
            };
            await this.contentService.create({ userId }, contentDto as unknown as CreateContentDto);
            this.logger.log('Created new Facebook like content', {
              likeId: like.id,
            });
          }
        } catch (error) {
          this.logger.error('Error processing Facebook like', {
            likeId: like.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Facebook likes transformation completed', {
        userId,
        connectionId: connection.id,
        processedCount: likes.length,
      });
    } catch (error) {
      this.logger.error('Error transforming Facebook likes', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractLikes(content: unknown): FacebookLike[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookLike[];
    }

    if ('likes' in contentObj && Array.isArray(contentObj.likes)) {
      return contentObj.likes as FacebookLike[];
    }

    return [];
  }
}
