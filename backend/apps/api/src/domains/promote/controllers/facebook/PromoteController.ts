import { Controller } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';
import { EventPayloads, Events, OnEvent } from '@ci/domains/events';

import { FacebookFriendsPromotionService } from '../../services/facebook/FacebookFriendsPromotionService';
import { FacebookLikesPromotionService } from '../../services/facebook/FacebookLikesPromotionService';
import { FacebookPhotosPromotionService } from '../../services/facebook/FacebookPhotosPromotionService';
import { FacebookPostsPromotionService } from '../../services/facebook/FacebookPostsPromotionService';
import { FacebookProfilePromotionService } from '../../services/facebook/FacebookProfilePromotionService';
import { FacebookVideosPromotionService } from '../../services/facebook/FacebookVideosPromotionService';

@Controller('promote')
export class PromoteController {
  private logger = new LoggerService(PromoteController.name);

  constructor(
    private readonly facebookProfilePromotionService: FacebookProfilePromotionService,
    private readonly facebookPostsPromotionService: FacebookPostsPromotionService,
    private readonly facebookPhotosPromotionService: FacebookPhotosPromotionService,
    private readonly facebookVideosPromotionService: FacebookVideosPromotionService,
    private readonly facebookFriendsPromotionService: FacebookFriendsPromotionService,
    private readonly facebookLikesPromotionService: FacebookLikesPromotionService,
  ) {}

  /**
   * Handle Facebook profile promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes Facebook profile to person entities
   */
  @OnEvent(Events.PROMOTE_FACEBOOK_PROFILE)
  async handlePromoteFacebookProfile(payload: EventPayloads[Events.PROMOTE_FACEBOOK_PROFILE]) {
    this.logger.log('Processing Facebook profile promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.facebookProfilePromotionService.promoteProfile(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('Facebook profile promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('Facebook profile promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Handle Facebook posts promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes Facebook posts to content table
   */
  @OnEvent(Events.PROMOTE_FACEBOOK_POSTS)
  async handlePromoteFacebookPosts(payload: EventPayloads[Events.PROMOTE_FACEBOOK_POSTS]) {
    this.logger.log('Processing Facebook posts promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.facebookPostsPromotionService.promotePosts(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('Facebook posts promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('Facebook posts promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Handle Facebook photos promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes Facebook photos as posts to content table
   */
  @OnEvent(Events.PROMOTE_FACEBOOK_PHOTOS)
  async handlePromoteFacebookPhotos(payload: EventPayloads[Events.PROMOTE_FACEBOOK_PHOTOS]) {
    this.logger.log('Processing Facebook photos promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.facebookPhotosPromotionService.promotePhotosAsPosts(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('Facebook photos promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('Facebook photos promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Handle Facebook videos promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes Facebook videos as posts to content table
   */
  @OnEvent(Events.PROMOTE_FACEBOOK_VIDEOS)
  async handlePromoteFacebookVideos(payload: EventPayloads[Events.PROMOTE_FACEBOOK_VIDEOS]) {
    this.logger.log('Processing Facebook videos promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.facebookVideosPromotionService.promoteVideosAsPosts(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('Facebook videos promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('Facebook videos promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Handle Facebook friends promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes Facebook friends to person entities with KNOWS relationships
   */
  @OnEvent(Events.PROMOTE_FACEBOOK_FRIENDS)
  async handlePromoteFacebookFriends(payload: EventPayloads[Events.PROMOTE_FACEBOOK_FRIENDS]) {
    this.logger.log('Processing Facebook friends promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.facebookFriendsPromotionService.promoteFriends(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('Facebook friends promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('Facebook friends promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Handle Facebook likes promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes Facebook likes (pages) to content table
   */
  @OnEvent(Events.PROMOTE_FACEBOOK_LIKES)
  async handlePromoteFacebookLikes(payload: EventPayloads[Events.PROMOTE_FACEBOOK_LIKES]) {
    this.logger.log('Processing Facebook likes promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.facebookLikesPromotionService.promoteLikes(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('Facebook likes promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('Facebook likes promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
