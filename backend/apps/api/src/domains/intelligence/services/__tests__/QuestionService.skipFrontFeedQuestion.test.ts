import { QuestionService } from '../QuestionService';

/**
 * `findOneUnanswered` deterministically returns the same front-of-queue row
 * every time (`ORDER BY enqueued_at ASC ... LIMIT 1`), and the only thing
 * that ever moves it was `rotateStaleFeedQuestions` — gated on 30 minutes of
 * inactivity. The frontend's "Skip" used to just hide the card locally and
 * refetch, which handed back the identical question: the same reflection
 * came right back on the next reload, with no memory of having been skipped.
 *
 * `skipFrontFeedQuestion` is the fix — an explicit, user-initiated rotation
 * that bypasses the staleness gate entirely, reusing the exact "move to
 * back" SQL `rotateStaleFeedQuestions` already performs.
 */
function makeService() {
  const dataSource = { query: jest.fn() };
  const questionRepository = {};
  const eventService = {};
  const service = new QuestionService(
    dataSource as never,
    questionRepository as never,
    eventService as never,
  );

  // Both are private; spying at runtime rather than through the type system
  // isolates skipFrontFeedQuestion's own orchestration from their internals,
  // which are exercised by rotateStaleFeedQuestions's own tests.
  const rotateFeedQueueRow = jest
    .spyOn(service as unknown as { rotateFeedQueueRow: (id: string) => Promise<void> }, 'rotateFeedQueueRow')
    .mockResolvedValue(undefined);
  const enqueueNextFeedQueueQuestion = jest
    .spyOn(service, 'enqueueNextFeedQueueQuestion')
    .mockResolvedValue(false);

  return { service, dataSource, rotateFeedQueueRow, enqueueNextFeedQueueQuestion };
}

describe('QuestionService.skipFrontFeedQuestion', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rotates the named row to the back and tops up the queue', async () => {
    const { service, dataSource, rotateFeedQueueRow, enqueueNextFeedQueueQuestion } = makeService();
    dataSource.query.mockResolvedValue([{ feed_queue_id: 'fq-1' }]);

    const result = await service.skipFrontFeedQuestion('user-1', 'fq-1');

    expect(result).toBe(true);
    expect(rotateFeedQueueRow).toHaveBeenCalledWith('fq-1');
    expect(enqueueNextFeedQueueQuestion).toHaveBeenCalledWith('user-1', 3);
  });

  it('scopes the existence check to the caller — cannot skip another user’s row', async () => {
    const { service, dataSource } = makeService();
    dataSource.query.mockResolvedValue([{ feed_queue_id: 'fq-1' }]);

    await service.skipFrontFeedQuestion('user-1', 'fq-1');

    const [, params] = dataSource.query.mock.calls[0];
    expect(params).toEqual(['fq-1', 'user-1']);
  });

  it('is a no-op, not an error, when the row has already moved on', async () => {
    const { service, dataSource, rotateFeedQueueRow } = makeService();
    dataSource.query.mockResolvedValue([]);

    const result = await service.skipFrontFeedQuestion('user-1', 'fq-stale');

    expect(result).toBe(false);
    expect(rotateFeedQueueRow).not.toHaveBeenCalled();
  });
});
