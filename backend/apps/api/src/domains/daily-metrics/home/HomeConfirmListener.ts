import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { AnswerCreatedEvent, type AnswerCreatedPayload } from '@ci/domains/intelligence/events';

import { DailyMetricsService } from '../services/DailyMetricsService';

import { HOME_QUESTION_ID } from './homeConfirm';
import { HomeConfirmService } from './HomeConfirmService';

/**
 * Q&A answers against the seeded home question write the same LIVES_IN edge
 * the selector persist path uses.
 */
@Injectable()
export class HomeConfirmListener {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly homeConfirm: HomeConfirmService,
    private readonly dailyMetrics: DailyMetricsService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(HomeConfirmListener.name);
  }

  @OnEvent(AnswerCreatedEvent)
  async onAnswerCreated(payload: AnswerCreatedPayload): Promise<void> {
    const rows = (await this.dataSource.query(
      `
      SELECT a.user_id::text AS user_id,
             a.question_id::text AS question_id,
             a.answer_text AS text
        FROM ci.answers a
       WHERE a.answer_id = $1
       LIMIT 1
      `,
      [payload.answerId],
    )) as Array<{ user_id: string; question_id: string; text: string | null }>;

    const row = rows[0];
    if (!row || row.question_id !== HOME_QUESTION_ID || !row.text?.trim()) {
      return;
    }

    const context = { userId: row.user_id } satisfies UserServiceContext;
    try {
      const wrote = await this.homeConfirm.confirmFromResponse(context, row.text.trim());
      if (wrote) {
        void this.dailyMetrics.refreshForUser(context).catch((error: unknown) => {
          this.logger.warn('Home confirm metrics refresh failed', {
            userId: context.userId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      this.logger.warn('Home confirm from answer failed', {
        answerId: payload.answerId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }
}
