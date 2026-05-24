import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { SummaryCreatedEvent, type SummaryCreatedPayload } from '@ci/domains/summaries/events';

import { ActionCreatedEvent, type ActionCreatedPayload } from '../events';

const FEED_QUEUE_EVENTS = 'feed-queue';

@Injectable()
export class FeedQueuePopulationListener {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FeedQueuePopulationListener.name);
  }

  @OnEvent(ActionCreatedEvent, { queue: FEED_QUEUE_EVENTS })
  async enqueueAction(payload: ActionCreatedPayload): Promise<void> {
    await this.dataSource.query(
      `
      INSERT INTO ci.feed_queue (feed_queue_id, user_id, item_type, action_id, enqueued_at)
      VALUES ($1, $2, 'action', $3, NOW())
      ON CONFLICT DO NOTHING;
      `,
      [uuidv7(), payload.userId, payload.actionId],
    );
  }

  @OnEvent(SummaryCreatedEvent, { queue: FEED_QUEUE_EVENTS })
  async enqueueSummary(payload: SummaryCreatedPayload): Promise<void> {
    type Row = {
      user_id: string;
      dismissed: boolean;
    };

    const rows = (await this.dataSource.query(
      `
      SELECT user_id, dismissed
      FROM ci.summaries
      WHERE summary_id = $1
      LIMIT 1;
      `,
      [payload.summaryId],
    )) satisfies Array<Row>;

    const summary = rows[0];
    if (!summary) {
      this.logger.warn('Summary not found for feed queue population', {
        summaryId: payload.summaryId,
      });

      return;
    }

    if (summary.dismissed) {
      return;
    }

    await this.dataSource.query(
      `
      INSERT INTO ci.feed_queue (feed_queue_id, user_id, item_type, summary_id, enqueued_at)
      VALUES ($1, $2, 'summary', $3, NOW())
      ON CONFLICT DO NOTHING;
      `,
      [uuidv7(), summary.user_id, payload.summaryId],
    );
  }
}
