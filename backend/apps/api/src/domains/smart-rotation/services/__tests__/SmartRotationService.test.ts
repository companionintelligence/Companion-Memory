import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import type { QuestionService } from '@ci/domains/intelligence';

import { SmartRotationWorkEvent } from '../../events';
import { SMART_ROTATION_BACKLOG_THRESHOLD, SMART_ROTATION_QUEUE } from '../../types';
import { SmartRotationService } from '../SmartRotationService';

function createService(
  overrides: {
    dataSource?: { query: jest.Mock };
    questionService?: Partial<QuestionService>;
    eventService?: { send: jest.Mock };
    featureService?: { isFeatureEnabled: jest.Mock };
  } = {},
) {
  const dataSource = overrides.dataSource ?? { query: jest.fn().mockResolvedValue([{ count: '0' }]) };
  const questionService = (overrides.questionService ?? {}) as QuestionService;
  const eventService = (overrides.eventService ?? {
    send: jest.fn().mockResolvedValue(['job-1']),
  }) as unknown as EventService;
  const featureService = (overrides.featureService ?? {
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
  }) as unknown as FeatureService;
  const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

  return {
    service: new SmartRotationService(
      dataSource as never,
      questionService,
      eventService,
      featureService,
      logger,
    ),
    dataSource,
    questionService,
    eventService,
    featureService,
  };
}

describe('SmartRotationService.enqueueWork', () => {
  it('uses a singleton key on the smart-rotation queue', async () => {
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({ eventService: { send } });

    await service.enqueueWork('user-1', 'question_feed');

    expect(send).toHaveBeenCalledWith(
      SmartRotationWorkEvent,
      { userId: 'user-1', workType: 'question_feed' },
      {
        queue: SMART_ROTATION_QUEUE,
        singletonKey: 'smart-rotation:user-1:question_feed',
        priority: -2,
      },
    );
  });

  it.each([
    ['graph_link', 5],
    ['graph_enrich', 5],
    ['context_prompt', 5],
    ['hydrate_answers', 5],
    ['hydrate_things', 5],
    ['schedule_sync', 2],
    ['summaries', 2],
    ['insights', 2],
    ['answer_infer', -2],
    ['question_feed', -2],
  ] as const)('assigns priority %s -> %d for workType %s', async (workType, priority) => {
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({ eventService: { send } });

    await service.enqueueWork('user-1', workType);

    expect(send).toHaveBeenCalledWith(
      SmartRotationWorkEvent,
      { userId: 'user-1', workType },
      expect.objectContaining({ priority }),
    );
  });

  it('returns false when the event was deduped (no job ids returned)', async () => {
    const send = jest.fn().mockResolvedValue([]);
    const { service } = createService({ eventService: { send } });

    await expect(service.enqueueWork('user-1', 'graph_link')).resolves.toBe(false);
  });
});

describe('SmartRotationService.runScheduledWork', () => {
  it('returns early when smart.rotation is disabled', async () => {
    const { service, questionService } = createService({
      featureService: { isFeatureEnabled: jest.fn().mockResolvedValue(false) },
      questionService: { listFeedQueueUserIds: jest.fn() },
    });

    await expect(service.runScheduledWork('question_feed')).resolves.toBe(0);
    expect(questionService.listFeedQueueUserIds).not.toHaveBeenCalled();
  });

  it('enqueues work for users in the round-robin batch', async () => {
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({
      eventService: { send },
      questionService: {
        listFeedQueueUserIds: jest.fn().mockResolvedValue(['user-1', 'user-2']),
      },
    });

    await expect(service.runScheduledWork('schedule_sync', 2)).resolves.toBe(2);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('short-circuits without enqueueing when there are no feed-queue users', async () => {
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({
      eventService: { send },
      questionService: { listFeedQueueUserIds: jest.fn().mockResolvedValue([]) },
    });

    await expect(service.runScheduledWork('schedule_sync', 5)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('only counts enqueues that actually produced a job id', async () => {
    const send = jest.fn().mockResolvedValueOnce(['job-1']).mockResolvedValueOnce([]);
    const { service } = createService({
      eventService: { send },
      questionService: {
        listFeedQueueUserIds: jest.fn().mockResolvedValue(['user-1', 'user-2']),
      },
    });

    await expect(service.runScheduledWork('schedule_sync', 2)).resolves.toBe(1);
  });

  it('advances the round-robin cursor across ticks and wraps around', async () => {
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({
      eventService: { send },
      questionService: {
        listFeedQueueUserIds: jest.fn().mockResolvedValue(['user-1', 'user-2', 'user-3']),
      },
    });

    // First tick takes 2 users starting at cursor 0: user-1, user-2.
    await service.runScheduledWork('graph_link', 2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      SmartRotationWorkEvent,
      { userId: 'user-1', workType: 'graph_link' },
      expect.anything(),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      SmartRotationWorkEvent,
      { userId: 'user-2', workType: 'graph_link' },
      expect.anything(),
    );

    // Second tick resumes at cursor 2, wraps after user-3 back to user-1.
    await service.runScheduledWork('graph_link', 2);
    expect(send).toHaveBeenNthCalledWith(
      3,
      SmartRotationWorkEvent,
      { userId: 'user-3', workType: 'graph_link' },
      expect.anything(),
    );
    expect(send).toHaveBeenNthCalledWith(
      4,
      SmartRotationWorkEvent,
      { userId: 'user-1', workType: 'graph_link' },
      expect.anything(),
    );
  });

  it('keeps independent cursors per work type', async () => {
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({
      eventService: { send },
      questionService: {
        listFeedQueueUserIds: jest.fn().mockResolvedValue(['user-1', 'user-2', 'user-3']),
      },
    });

    await service.runScheduledWork('graph_link', 1); // consumes user-1 for graph_link
    await service.runScheduledWork('schedule_sync', 1); // should also start at user-1, its own cursor

    expect(send).toHaveBeenNthCalledWith(
      1,
      SmartRotationWorkEvent,
      { userId: 'user-1', workType: 'graph_link' },
      expect.anything(),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      SmartRotationWorkEvent,
      { userId: 'user-1', workType: 'schedule_sync' },
      expect.anything(),
    );

    // graph_link cursor continues from user-2 on its next tick, unaffected by schedule_sync's tick.
    await service.runScheduledWork('graph_link', 1);
    expect(send).toHaveBeenNthCalledWith(
      3,
      SmartRotationWorkEvent,
      { userId: 'user-2', workType: 'graph_link' },
      expect.anything(),
    );
  });

  it('skips low-priority work types (answer_infer, question_feed) when the backlog is high', async () => {
    const query = jest.fn().mockResolvedValue([{ count: String(SMART_ROTATION_BACKLOG_THRESHOLD) }]);
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({
      dataSource: { query },
      eventService: { send },
      questionService: { listFeedQueueUserIds: jest.fn().mockResolvedValue(['user-1']) },
    });

    await expect(service.runScheduledWork('answer_infer')).resolves.toBe(0);
    await expect(service.runScheduledWork('question_feed')).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not gate high-priority work types on backlog even when it is high', async () => {
    const query = jest.fn().mockResolvedValue([{ count: String(SMART_ROTATION_BACKLOG_THRESHOLD) }]);
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({
      dataSource: { query },
      eventService: { send },
      questionService: { listFeedQueueUserIds: jest.fn().mockResolvedValue(['user-1']) },
    });

    await expect(service.runScheduledWork('graph_link')).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not treat a backlog count just under the threshold as high', async () => {
    const query = jest.fn().mockResolvedValue([{ count: String(SMART_ROTATION_BACKLOG_THRESHOLD - 1) }]);
    const send = jest.fn().mockResolvedValue(['job-1']);
    const { service } = createService({
      dataSource: { query },
      eventService: { send },
      questionService: { listFeedQueueUserIds: jest.fn().mockResolvedValue(['user-1']) },
    });

    await expect(service.runScheduledWork('answer_infer')).resolves.toBe(1);
  });
});
