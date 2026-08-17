import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import type { QuestionService } from '@ci/domains/intelligence';

import { AnswerInferenceCron } from '../AnswerInferenceCron';

describe('AnswerInferenceCron with smart.rotation', () => {
  it('defers to the orchestrator when smart.rotation is enabled', async () => {
    const eventService = { send: jest.fn() } as unknown as EventService;
    const questionService = { findUnansweredByUserId: jest.fn() } as unknown as QuestionService;
    const featureService = {
      isFeatureEnabled: jest.fn().mockImplementation(async (key: string) => key === 'smart.rotation'),
    } as unknown as FeatureService;
    const logger = { setContext() {}, log() {} } as unknown as LoggerService;

    const cron = new AnswerInferenceCron(eventService, questionService, logger, featureService);

    await cron.cronInferAnswers();

    expect(questionService.findUnansweredByUserId).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('still respects scheduled.answer.inferencing when smart.rotation is off', async () => {
    const eventService = { send: jest.fn() } as unknown as EventService;
    const questionService = {
      findUnansweredByUserId: jest.fn().mockResolvedValue(new Map()),
    } as unknown as QuestionService;
    const featureService = {
      isFeatureEnabled: jest
        .fn()
        .mockImplementation(async (key: string) => key === 'scheduled.answer.inferencing'),
    } as unknown as FeatureService;
    const logger = { setContext() {}, log() {} } as unknown as LoggerService;

    const cron = new AnswerInferenceCron(eventService, questionService, logger, featureService);

    await cron.cronInferAnswers();

    expect(questionService.findUnansweredByUserId).toHaveBeenCalled();
  });
});
