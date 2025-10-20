import { Controller } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import { ApiLogEntity } from '@ci/domains/etl';
import { EventPayloads, Events, OnEvent } from '@ci/domains/events';
import { OutlookCalendarPromotionService } from '@ci/domains/promote/services/microsoft/OutlookCalendarPromotionService';
import { OutlookMailPromotionService } from '@ci/domains/promote/services/microsoft/OutlookMailPromotionService';

import { PromoteService } from '../../services/PromoteService';

@Controller('promote')
export class PromoteController {
  private logger = new LoggerService(PromoteController.name);

  constructor(
    private readonly promoteService: PromoteService,
    private readonly outlookMailPromotionService: OutlookMailPromotionService,
    private readonly outlookCalendarPromotionService: OutlookCalendarPromotionService,
    @InjectRepository(ApiLogEntity)
    private readonly apiLogRepository: Repository<ApiLogEntity>,
  ) {}

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
}
