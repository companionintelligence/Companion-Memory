import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { ContentService, type CreateContentDto, ContentEntity } from '@ci/domains/memory';

import { FacebookPromotionUtils } from './FacebookPromotionUtils';

interface FacebookPost {
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
        source?: string;
      };
      subattachments?: {
        data: Array<{
          url: string;
          type: string;
          media?: {
            image?: { src: string };
            source?: string;
          };
        }>;
      };
    }>;
  };
}

@Injectable()
export class FacebookPostsPromotionService {
  constructor(
    private readonly contentService: ContentService,
    @InjectRepository(ContentEntity)
    private readonly contentRepository: Repository<ContentEntity>,
    private readonly utils: FacebookPromotionUtils,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookPostsPromotionService.name);
  }

  async promotePosts(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Promoting Facebook posts', { userId, connectionId });

    const posts = this.extractPosts(apiLogContent);
    if (posts.length === 0) {
      this.logger.log('No Facebook posts found to promote', { userId, connectionId });

      return;
    }

    for (const post of posts) {
      try {
        // Create a meaningful title from the post content
        const postTitle = post.message
          ? post.message.length > 100
            ? `${post.message.substring(0, 97)}...`
            : post.message
          : post.story
            ? post.story.length > 100
              ? `${post.story.substring(0, 97)}...`
              : post.story
            : `Facebook ${post.type || 'Post'}`;

        // Format created_time for display
        const createdDate = post.created_time ? new Date(post.created_time).toLocaleString() : undefined;

        // Extract media URLs from attachments if available and download them
        const mediaUrls: string[] = [];
        const fileIds: string[] = [];

        // Download full_picture if available
        if (post.full_picture) {
          mediaUrls.push(post.full_picture);
          try {
            const fileRecord = await this.utils.downloadAndSaveFile(
              post.full_picture,
              `${post.id}_picture`,
              userId,
              connectionId,
              'image',
              `facebook photo ${post.id}_picture`,
            );
            if (fileRecord) {
              fileIds.push(fileRecord.id);
            }
          } catch (error) {
            this.logger.warn('Failed to download post picture', {
              postId: post.id,
              url: post.full_picture,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }

        // Process attachments
        if (post.attachments?.data) {
          for (const attachment of post.attachments.data) {
            if (attachment.media?.image?.src) {
              mediaUrls.push(attachment.media.image.src);
              try {
                const fileRecord = await this.utils.downloadAndSaveFile(
                  attachment.media.image.src,
                  `${post.id}_attachment_image_${fileIds.length}`,
                  userId,
                  connectionId,
                  'image',
                  `facebook photo ${post.id}_attachment_${fileIds.length}`,
                );
                if (fileRecord) {
                  fileIds.push(fileRecord.id);
                }
              } catch (error) {
                this.logger.warn('Failed to download attachment image', {
                  postId: post.id,
                  url: attachment.media.image.src,
                  error: error instanceof Error ? error.message : 'Unknown error',
                });
              }
            }

            if (post.type === 'video' && attachment.media?.source) {
              mediaUrls.push(attachment.media.source);
              try {
                const fileRecord = await this.utils.downloadAndSaveFile(
                  attachment.media.source,
                  `${post.id}_attachment_video_${fileIds.length}`,
                  userId,
                  connectionId,
                  'video',
                  `facebook video ${post.id}_attachment_${fileIds.length}`,
                );
                if (fileRecord) {
                  fileIds.push(fileRecord.id);
                }
              } catch (error) {
                this.logger.warn('Failed to download attachment video', {
                  postId: post.id,
                  url: attachment.media.source,
                  error: error instanceof Error ? error.message : 'Unknown error',
                });
              }
            }

            if (attachment.subattachments?.data) {
              for (const subattachment of attachment.subattachments.data) {
                if (subattachment.media?.image?.src) {
                  mediaUrls.push(subattachment.media.image.src);
                  try {
                    const fileRecord = await this.utils.downloadAndSaveFile(
                      subattachment.media.image.src,
                      `${post.id}_subattachment_image_${fileIds.length}`,
                      userId,
                      connectionId,
                      'image',
                      `facebook photo ${post.id}_subattachment_${fileIds.length}`,
                    );
                    if (fileRecord) {
                      fileIds.push(fileRecord.id);
                    }
                  } catch (error) {
                    this.logger.warn('Failed to download subattachment image', {
                      postId: post.id,
                      url: subattachment.media.image.src,
                      error: error instanceof Error ? error.message : 'Unknown error',
                    });
                  }
                }

                if (subattachment.type === 'video' && subattachment.media?.source) {
                  mediaUrls.push(subattachment.media.source);
                  try {
                    const fileRecord = await this.utils.downloadAndSaveFile(
                      subattachment.media.source,
                      `${post.id}_subattachment_video_${fileIds.length}`,
                      userId,
                      connectionId,
                      'video',
                      `facebook video ${post.id}_subattachment_${fileIds.length}`,
                    );
                    if (fileRecord) {
                      fileIds.push(fileRecord.id);
                    }
                  } catch (error) {
                    this.logger.warn('Failed to download subattachment video', {
                      postId: post.id,
                      url: subattachment.media.source,
                      error: error instanceof Error ? error.message : 'Unknown error',
                    });
                  }
                }
              }
            }
          }
        }

        // Build comprehensive text description
        const textParts: string[] = [];
        if (post.message) {
          textParts.push(post.message);
        }

        if (post.story && post.story !== post.message) {
          textParts.push(post.story);
        }

        if (createdDate) {
          textParts.push(`Posted on ${createdDate}`);
        }

        if (fileIds.length > 0) {
          const mediaCount = fileIds.length;
          const mediaType =
            fileIds.length === 1 ? (fileIds[0] ? 'media file' : '') : `${mediaCount} media files`;
          if (mediaType) {
            textParts.push(`Includes ${mediaType}`);
          }
        }

        // Construct Facebook post URL if not provided
        let postLink = post.link;
        if (!postLink && post.id) {
          // Try to construct URL from post ID (format: {user_id}_{post_id})
          postLink = `https://www.facebook.com/${post.id}`;
        }

        // Always create a content record for the post, even if it has no media files
        const contentDto = {
          id: '',
          type: 'Content',
          title: postTitle,
          text: textParts.join('\n\n') || `Facebook post from ${createdDate || 'Facebook'}`,
          url: postLink || undefined,
          mimetype: 'text/plain',
          external_id: post.id,
          source_url: postLink || undefined,
          source_data: {
            facebook_post_id: post.id,
            created_time: post.created_time,
            created_time_formatted: createdDate,
            type: post.type,
            connection_id: connectionId,
            // Store all post metadata
            message: post.message,
            story: post.story,
            link: postLink,
            full_picture: post.full_picture,
            picture: post.picture,
            attachments: post.attachments,
            media_urls: mediaUrls.length > 0 ? mediaUrls : undefined,
            // Link to downloaded files (empty array if no files)
            file_ids: fileIds.length > 0 ? fileIds : undefined,
            // For backward compatibility, also store the first file_id if only one file
            file_id: fileIds.length === 1 ? fileIds[0] : undefined,
            // Store media count for easy reference
            media_count: fileIds.length,
          },
          user: { id: userId },
        };

        // Check if content already exists for this post (deduplication)
        const existingContent = await this.contentRepository.findOne({
          where: {
            user: { id: userId },
            externalId: post.id,
          },
        });

        if (existingContent) {
          this.logger.debug('Content record already exists for Facebook post, skipping', {
            postId: post.id,
            existingContentId: existingContent.id,
          });
          continue;
        }

        this.logger.log('Creating content record for Facebook post', {
          postId: post.id,
          title: postTitle,
          fileCount: fileIds.length,
          hasMessage: !!post.message,
          hasStory: !!post.story,
          type: contentDto.type,
          externalId: contentDto.external_id,
        });

        try {
          const createdContent = await this.contentService.create(
            { userId },
            contentDto as unknown as CreateContentDto,
          );
          const contentRecord = Array.isArray(createdContent) ? createdContent[0] : createdContent;
          const contentId = contentRecord?.id ?? post.id;

          this.logger.log('Successfully created content record for Facebook post', {
            postId: post.id,
            contentId,
            fileCount: fileIds.length,
            type: contentRecord.type,
          });
        } catch (contentError) {
          this.logger.error('Failed to create content record for Facebook post', {
            postId: post.id,
            error: contentError instanceof Error ? contentError.message : 'Unknown error',
            stack: contentError instanceof Error ? contentError.stack : undefined,
            contentDto: {
              type: contentDto.type,
              title: contentDto.title,
              external_id: contentDto.external_id,
            },
          });
          // Don't throw - continue processing other posts
        }
      } catch (error) {
        this.logger.error('Error processing Facebook post', {
          postId: post.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Facebook posts promotion completed', {
      userId,
      connectionId,
      processedCount: posts.length,
    });
  }

  private extractPosts(content: unknown): FacebookPost[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookPost[];
    }

    if ('data' in contentObj && Array.isArray(contentObj.data)) {
      return contentObj.data as FacebookPost[];
    }

    return [];
  }
}
