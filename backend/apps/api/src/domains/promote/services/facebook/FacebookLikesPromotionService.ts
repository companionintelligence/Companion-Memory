import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { FacebookPromotionUtils } from './FacebookPromotionUtils';

interface FacebookLike {
  id: string;
  name: string;
  category?: string;
  link?: string;
}

@Injectable()
export class FacebookLikesPromotionService {
  private logger = new LoggerService(FacebookLikesPromotionService.name);

  constructor(
    private readonly contentService: ContentService,
    private readonly utils: FacebookPromotionUtils,
  ) {}

  async promoteLikes(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Promoting Facebook likes', { userId, connectionId });

    const likes = this.extractLikes(apiLogContent);
    if (likes.length === 0) {
      this.logger.log('No Facebook likes found to promote', { userId, connectionId });

      return;
    }

    for (const like of likes) {
      try {
        const contentDto = {
          id: '',
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
            connection_id: connectionId,
            contentType: 'facebook_like', // Store original type in source_data
          },
          user: { id: userId },
        };

        const createdContent = await this.contentService.create(
          { userId },
          contentDto as unknown as CreateContentDto,
        );
        const contentRecord = Array.isArray(createdContent) ? createdContent[0] : createdContent;
        const contentId = contentRecord?.id ?? like.id;

        await this.utils.enqueueContentEmbedding(
          userId,
          contentId,
          this.utils.buildContentSearchText(contentDto),
        );
      } catch (error) {
        this.logger.error('Error processing Facebook like', {
          likeId: like.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Facebook likes promotion completed', {
      userId,
      connectionId,
      processedCount: likes.length,
    });
  }

  private extractLikes(content: unknown): FacebookLike[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookLike[];
    }

    if ('data' in contentObj && Array.isArray(contentObj.data)) {
      return contentObj.data as FacebookLike[];
    }

    return [];
  }
}
