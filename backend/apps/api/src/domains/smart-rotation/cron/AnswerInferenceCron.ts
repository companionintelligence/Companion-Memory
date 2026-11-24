import { Injectable } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import config from '@ci/configuration';
import { EventService, Events } from '@ci/domains/events';
import { QuestionService } from '@ci/domains/intelligence';
import { LLM_BACKGROUND_QUEUE } from '@ci/domains/llm';

import {
  INFERENCE_ATTEMPT_COOLDOWN_HOURS,
  INFERENCE_QUEUE_RETENTION_MINUTES,
} from '../listeners/SmartRotationListener';

// Second 55, not 0. `CronExpression.EVERY_MINUTE` is `*/1 * * * *`, which
// `cron` right-aligns to second 0 of every minute — the second every schedule
// that never picked one already fires on. Off the pile-up. See
// common/schedule/__tests__/cronSecondOffsets.test.ts for who holds what.
//
// The TICK is once a minute; the DISPATCH is not. Each owner is sent at most
// one inference per `llm.answerInferenceIntervalMinutes`, and none while their
// last one is still waiting or running — the selection enforces both (see
// inferenceDispatchGate.ts). The tick only sets how soon after the interval
// elapses an owner is picked up again. It used to be the cadence itself: one
// job a minute per owner, whatever the queue already held — 240 an hour,
// around the clock, on a four-person appliance. That is more than one GPU slot
// can finish, so core-1's queue fell ~4 h behind with 941 waiting (2026-10-17).
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
    // recently" — and, per owner, as "still outstanding" or "sent too recently".
    const unansweredQuestions = await this.questionService.findUnansweredByUserId({
      queue: LLM_BACKGROUND_QUEUE,
      eventName: Events.INFER_QUESTION_ANSWER,
      cooldownHours: INFERENCE_ATTEMPT_COOLDOWN_HOURS,
      intervalMinutes: config.llm.answerInferenceIntervalMinutes,
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
            retentionMinutes: INFERENCE_QUEUE_RETENTION_MINUTES,
          },
        );
      }
    }
  }
}
