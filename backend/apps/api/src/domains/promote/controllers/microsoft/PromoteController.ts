import { Controller } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { EventPayloads, Events, OnEvent } from '@ci/domains/events';
import { OneDrivePromotionService } from '@ci/domains/promote/services/microsoft/OneDrivePromotionService';
import { OutlookCalendarPromotionService } from '@ci/domains/promote/services/microsoft/OutlookCalendarPromotionService';
import { OutlookMailPromotionService } from '@ci/domains/promote/services/microsoft/OutlookMailPromotionService';

@Controller('promote')
export class PromoteController {
  constructor(
    private readonly outlookMailPromotionService: OutlookMailPromotionService,
    private readonly outlookCalendarPromotionService: OutlookCalendarPromotionService,
    private readonly oneDrivePromotionService: OneDrivePromotionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PromoteController.name);
  }

  /**
   * Handle Outlook Mail message promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes Outlook Mail messages to the communications table and creates person entities
   */
  @OnEvent(Events.PROMOTE_OUTLOOK_MAIL_MESSAGES)
  async handlePromoteOutlookMail(payload: EventPayloads[Events.PROMOTE_OUTLOOK_MAIL_MESSAGES]) {
    this.logger.log('Processing Outlook Mail promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.outlookMailPromotionService.promoteOutlookMailMessages(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('Outlook Mail promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('Outlook Mail promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Handle Outlook Calendar event promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes Outlook Calendar events to the event table and creates person entities
   */
  @OnEvent(Events.PROMOTE_OUTLOOK_CALENDAR_EVENTS)
  async handlePromoteOutlookCalendar(payload: EventPayloads[Events.PROMOTE_OUTLOOK_CALENDAR_EVENTS]) {
    this.logger.log('Processing Outlook Calendar promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.outlookCalendarPromotionService.promoteOutlookCalendarEvents(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('Outlook Calendar promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('Outlook Calendar promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Handle OneDrive file promotion event
   * This runs asynchronously in the job queue after the API log has been marked as processed
   * Promotes OneDrive files to the event table and creates person entities
   */
  @OnEvent(Events.PROMOTE_ONEDRIVE_FILES)
  async handlePromoteOneDrive(payload: EventPayloads[Events.PROMOTE_ONEDRIVE_FILES]) {
    this.logger.log('Processing OneDrive promotion job', {
      apiLogId: payload.apiLogId,
      userId: payload.userId,
    });

    try {
      await this.oneDrivePromotionService.promoteOneDriveFiles(
        payload.content,
        payload.userId,
        payload.connectionId,
      );

      this.logger.log('OneDrive file promotion completed successfully', {
        apiLogId: payload.apiLogId,
      });
    } catch (error) {
      // Log as warning - job will complete anyway to avoid infinite retries
      this.logger.warn('OneDrive file promotion failed', {
        apiLogId: payload.apiLogId,
        userId: payload.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
