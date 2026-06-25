import type { ServiceContext, UserServiceContext } from '@ci/common/context';

import { AnswerService } from '../AnswerService';
import { QuestionService } from '../QuestionService';

/**
 * Unit tests for the batch `createMany` added to the intelligence services
 * (Answer, Question) behind the createAnswers / createQuestions mutations.
 * `createMany` delegates to the single `create` (preserving per-row events and
 * side effects); these tests pin the batch contract — every item created, results
 * in input order — by spying on `create`.
 */
const ctx = { userId: 'user-1' } as UserServiceContext;

const signalling = () => ({ send: jest.fn() }) as never;
const stub = () => ({}) as never;

describe('AnswerService.createMany', () => {
  it('creates every answer and returns them in input order', async () => {
    const service = new AnswerService(stub(), signalling(), stub());
    const spy = jest
      .spyOn(service, 'create')
      .mockImplementation(async (_context: ServiceContext, dto) => ({ id: dto.text }) as never);

    const result = await service.createMany(ctx, [
      { text: 'a1', question: { id: 'q1' } },
      { text: 'a2', question: { id: 'q2' } },
    ]);

    expect(result.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('QuestionService.createMany', () => {
  it('creates every question and returns them in input order', async () => {
    const service = new QuestionService(stub(), stub(), signalling());
    const spy = jest
      .spyOn(service, 'create')
      .mockImplementation(async (_context: ServiceContext, dto) => ({ id: dto.text }) as never);

    const result = await service.createMany(ctx, [{ text: 'q1' }, { text: 'q2' }, { text: 'q3' }]);

    expect(result.map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('returns an empty array for an empty batch', async () => {
    const service = new QuestionService(stub(), stub(), signalling());
    const spy = jest.spyOn(service, 'create');

    await expect(service.createMany(ctx, [])).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
