import { Injectable } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { EventService, Events } from '@ci/domains/events';
import { QuestionService } from '@ci/domains/intelligence';
import { LLM_BACKGROUND_QUEUE } from '@ci/domains/llm';

import { INFERENCE_ATTEMPT_COOLDOWN_HOURS } from '../listeners/SmartRotationListener';

// Second 55, not 0. `CronExpression.EVERY_MINUTE` is `*/1 * * * *`, which
// `cron` right-aligns to second 0 of every minute — the second every schedule
// that never picked one already fires on. Same per-minute cadence, off the
// pile-up. See common/schedule/__tests__/cronSecondOffsets.test.ts for who
// holds what.
const ANSWER_INFERENCE_CRON = '55 * * * * *';

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

  @Cron(ANSWER_INFERENCE_CRON, { name: 'AnswerInferenceCron.cronInferAnswers' })
  async cronInferAnswers() {
    if (await this.featureService.isFeatureEnabled('smart.rotation')) {
      return;
    }

    const featureEnabled = await this.featureService.isFeatureEnabled('scheduled.answer.inferencing');

    if (!featureEnabled) {
      return;
    }

    this.logger.log('Processing question answer inference cron');

    // The attempt history keying: this cron dispatches INFER_QUESTION_ANSWER
    // onto LLM_BACKGROUND_QUEUE (AnswerInferenceListener's binding), and the
    // selection reads that same queue's pg-boss rows back as "already tried
    // recently".
    const unansweredQuestions = await this.questionService.findUnansweredByUserId({
      queue: LLM_BACKGROUND_QUEUE,
      eventName: Events.INFER_QUESTION_ANSWER,
      cooldownHours: INFERENCE_ATTEMPT_COOLDOWN_HOURS,
    });

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
