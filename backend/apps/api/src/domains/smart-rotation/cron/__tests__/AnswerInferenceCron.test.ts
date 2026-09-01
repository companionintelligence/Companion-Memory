import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import { Events, type EventService } from '@ci/domains/events';
import type { QuestionService } from '@ci/domains/intelligence';

import { AnswerInferenceCron } from '../AnswerInferenceCron';

/** smart.rotation off + scheduled.answer.inferencing on — the only combination that reaches the dispatch loop. */
function buildDispatchingFeatureService(): FeatureService {
  return {
    isFeatureEnabled: jest
      .fn()
      .mockImplementation(async (key: string) => key === 'scheduled.answer.inferencing'),
  } as unknown as FeatureService;
}

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

    // The attempt-history keying is what breaks the head-of-line loop: the
    // selection must read back the same queue/event this cron dispatches on.
    expect(questionService.findUnansweredByUserId).toHaveBeenCalledWith({
      queue: 'llm',
      eventName: Events.INFER_QUESTION_ANSWER,
      cooldownHours: 6,
    });
  });
});

describe('AnswerInferenceCron dispatch loop', () => {
  it('sends INFER_QUESTION_ANSWER for every question of every user with a singleton key per question', async () => {
    const eventService = { send: jest.fn().mockResolvedValue(['job-1']) } as unknown as EventService;
    const questionService = {
      findUnansweredByUserId: jest.fn().mockResolvedValue(
        new Map([
          ['user-1', ['q-1', 'q-2']],
          ['user-2', ['q-3']],
        ]),
      ),
    } as unknown as QuestionService;
    const featureService = buildDispatchingFeatureService();
    const logger = { setContext() {}, log() {} } as unknown as LoggerService;

    const cron = new AnswerInferenceCron(eventService, questionService, logger, featureService);

    await cron.cronInferAnswers();

    expect(eventService.send).toHaveBeenCalledTimes(3);
    expect(eventService.send).toHaveBeenNthCalledWith(
      1,
      Events.INFER_QUESTION_ANSWER,
      { ownerId: 'user-1', questionId: 'q-1' },
      { singletonKey: 'infer:user-1:q-1' },
    );
    expect(eventService.send).toHaveBeenNthCalledWith(
      2,
      Events.INFER_QUESTION_ANSWER,
      { ownerId: 'user-1', questionId: 'q-2' },
      { singletonKey: 'infer:user-1:q-2' },
    );
    expect(eventService.send).toHaveBeenNthCalledWith(
      3,
      Events.INFER_QUESTION_ANSWER,
      { ownerId: 'user-2', questionId: 'q-3' },
      { singletonKey: 'infer:user-2:q-3' },
    );
  });

  it('skips entries with a falsy userId without dispatching or throwing', async () => {
    const eventService = { send: jest.fn().mockResolvedValue(['job-1']) } as unknown as EventService;
    const questionService = {
      findUnansweredByUserId: jest.fn().mockResolvedValue(
        new Map([
          ['', ['q-orphan']],
          ['user-1', ['q-1']],
        ]),
      ),
    } as unknown as QuestionService;
    const featureService = buildDispatchingFeatureService();
    const logger = { setContext() {}, log() {} } as unknown as LoggerService;

    const cron = new AnswerInferenceCron(eventService, questionService, logger, featureService);

    await cron.cronInferAnswers();

    expect(eventService.send).toHaveBeenCalledTimes(1);
    expect(eventService.send).toHaveBeenCalledWith(
      Events.INFER_QUESTION_ANSWER,
      { ownerId: 'user-1', questionId: 'q-1' },
      { singletonKey: 'infer:user-1:q-1' },
    );
  });

  it('does not dispatch anything when a user has no unanswered questions', async () => {
    const eventService = { send: jest.fn() } as unknown as EventService;
    const questionService = {
      findUnansweredByUserId: jest.fn().mockResolvedValue(new Map([['user-1', []]])),
    } as unknown as QuestionService;
    const featureService = buildDispatchingFeatureService();
    const logger = { setContext() {}, log() {} } as unknown as LoggerService;

    const cron = new AnswerInferenceCron(eventService, questionService, logger, featureService);

    await cron.cronInferAnswers();

    expect(eventService.send).not.toHaveBeenCalled();
  });
});
