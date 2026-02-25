import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { QuestionService } from '../services/QuestionService';

const FEED_QUESTION_QUEUE_CRON = '0 */20 * * * *';
const FEED_QUESTION_QUEUE_LIMIT = 3;

@Injectable()
export class FeedQuestionQueueCron {
  constructor(
    private readonly questionService: QuestionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FeedQuestionQueueCron.name);
  }

  @Cron(FEED_QUESTION_QUEUE_CRON)
  async topUpFeedQuestionQueue() {
    const userIds = await this.questionService.listFeedQueueUserIds();
    let enqueueCount = 0;

    for (const userId of userIds) {
      const enqueued = await this.questionService.enqueueNextFeedQueueQuestion(
        userId,
        FEED_QUESTION_QUEUE_LIMIT,
      );

      if (enqueued) {
        enqueueCount += 1;
      }
    }

    this.logger.log('Processed feed question queue top-up', {
      usersProcessed: userIds.length,
      questionsEnqueued: enqueueCount,
    });
  }
}
