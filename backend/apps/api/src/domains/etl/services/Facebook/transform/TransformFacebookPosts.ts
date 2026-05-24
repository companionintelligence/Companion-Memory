import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
interface FacebookPost {
  id: string;
  message?: string;
  story?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  attachments?: {
    data: Array<{
      type: string;
      media?: {
        image?: {
          src: string;
        };
      };
      subattachments?: {
        data: Array<{
          media?: {
            image?: {
              src: string;
            };
          };
        }>;
      };
    }>;
  };
  from?: {
    id: string;
    name: string;
  };
  shares?: {
    count: number;
  };
  reactions?: {
    summary: {
      total_count: number;
    };
  };
  comments?: {
    summary: {
      total_count: number;
    };
  };
}
@Injectable()
export class FacebookPostsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookPostsTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;
    this.logger.log('Starting Facebook posts transformation', {
      userId,
      connectionId: connection.id,
    });
    try {
      const posts = this.extractPosts(data);
      if (posts.length === 0) {
        this.logger.log('No Facebook posts found to transform', { userId, connectionId: connection.id });

        return;
      }

      for (const post of posts) {
        try {
          // Extract image URLs from attachments
          const imageUrls: string[] = [];
          if (post.attachments?.data) {
            for (const attachment of post.attachments.data) {
              if (attachment.media?.image?.src) {
                imageUrls.push(attachment.media.image.src);
              }

              if (attachment.subattachments?.data) {
                for (const subattachment of attachment.subattachments.data) {
                  if (subattachment.media?.image?.src) {
                    imageUrls.push(subattachment.media.image.src);
                  }
                }
              }
            }
          }

          // Search for existing content by external_id
          const existingContent = await this.contentService.search({ userId }, { external_id: post.id });
          if (existingContent.length > 0) {
            // Update existing content
            const existingItem = existingContent[0];
            await this.contentService.update({ userId }, existingItem.id, {
              type: 'Content',
              title: post.message
                ? post.message.substring(0, 100) + (post.message.length > 100 ? '...' : '')
                : post.story || `Post ${post.id}`,
              text: post.message || post.story || '',
              url: post.permalink_url || undefined,
              mimetype: 'text/plain',
              external_id: post.id,
              source_url: post.permalink_url || undefined,
              source_data: {
                facebook_post_id: post.id,
                message: post.message,
                story: post.story,
                created_time: post.created_time,
                from: post.from,
                full_picture: post.full_picture,
                image_urls: imageUrls.length > 0 ? imageUrls : undefined,
                shares_count: post.shares?.count,
                reactions_count: post.reactions?.summary?.total_count,
                comments_count: post.comments?.summary?.total_count,
                connection_id: connection.id,
                contentType: 'facebook_post',
              },
            });
            this.logger.log('Updated existing Facebook post content', {
              postId: post.id,
              contentId: existingItem.id,
            });
          } else {
            // Create new content
            const contentDto = {
              id: uuidv7(),
              type: 'Content',
              title: post.message
                ? post.message.substring(0, 100) + (post.message.length > 100 ? '...' : '')
                : post.story || `Post ${post.id}`,
              text: post.message || post.story || '',
              url: post.permalink_url || undefined,
              mimetype: 'text/plain',
              external_id: post.id,
              source_url: post.permalink_url || undefined,
              source_data: {
                facebook_post_id: post.id,
                message: post.message,
                story: post.story,
                created_time: post.created_time,
                from: post.from,
                full_picture: post.full_picture,
                image_urls: imageUrls.length > 0 ? imageUrls : undefined,
                shares_count: post.shares?.count,
                reactions_count: post.reactions?.summary?.total_count,
                comments_count: post.comments?.summary?.total_count,
                connection_id: connection.id,
                contentType: 'facebook_post',
              },
              user: { id: userId },
            };
            await this.contentService.create({ userId }, contentDto as unknown as CreateContentDto);
            this.logger.log('Created new Facebook post content', {
              postId: post.id,
            });
          }
        } catch (error) {
          this.logger.error('Error processing Facebook post', {
            postId: post.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Facebook posts transformation completed', {
        userId,
        connectionId: connection.id,
        processedCount: posts.length,
      });
    } catch (error) {
      this.logger.error('Error transforming Facebook posts', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractPosts(content: unknown): FacebookPost[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookPost[];
    }

    if ('posts' in contentObj && Array.isArray(contentObj.posts)) {
      return contentObj.posts as FacebookPost[];
    }

    return [];
  }
}
