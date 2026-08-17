import { Injectable } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { EventService, Events } from '@ci/domains/events';
import { QuestionService } from '@ci/domains/intelligence';

@Injectable()
export class AnswerInferenceCron {
  constructor(
    private readonly eventService: EventService,
    private readonly questionService: QuestionService,
    private readonly logger: LoggerService,
    private readonly featureService: FeatureService,
  ) {
    this.logger.setContext(AnswerInferenceCron.name);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async cronInferAnswers() {
    if (await this.featureService.isFeatureEnabled('smart.rotation')) {
      return;
    }

    const featureEnabled = await this.featureService.isFeatureEnabled('scheduled.answer.inferencing');

    if (!featureEnabled) {
      return;
    }

    this.logger.log('Processing question answer inference cron');

    const unansweredQuestions = await this.questionService.findUnansweredByUserId();

    for (const [userId, questionIds] of unansweredQuestions) {
      if (!userId) {
        continue;
      }

      for (const questionId of questionIds) {
        await this.eventService.send(
          Events.INFER_QUESTION_ANSWER,
          {
            ownerId: userId,
            questionId: questionId,
          },
          {
            singletonKey: `infer:${userId}:${questionId}`,
          },
        );
      }
    }
  }
}
