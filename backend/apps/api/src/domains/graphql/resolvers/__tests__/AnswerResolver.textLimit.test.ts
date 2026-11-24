import { BadRequestException } from '@nestjs/common';

import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { AnswerResolver } from '../AnswerResolver';

/**
 * The GraphQL answer mutations take the same words as `POST /answers` and
 * `PATCH /answers/:id`, and for a while took them under none of those rules: the
 * REST controller ran `createAnswerSchema` / `updateAnswerSchema`, these ran
 * nothing, so an answer of any size went in, and a blank one got as far as the
 * `answer_text_not_empty` CHECK and came back a 500.
 *
 * MUTATION-TESTED: drop `checkedAnswerText` from any of the three and the
 * matching case below goes red.
 */

const CTX = { userId: 'user-1' } as unknown as RequestContext;
const QUESTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const ANSWER_ID = '660e8400-e29b-41d4-a716-446655440001';

const AT_CAP = 'a'.repeat(5000);
const OVER_CAP = 'a'.repeat(5001);

function makeResolver() {
  const answer = { id: ANSWER_ID, answer: AT_CAP, answerSource: 'user_input', answerMethod: 'user' };
  const answerService = {
    create: jest.fn().mockResolvedValue(answer),
    createMany: jest.fn().mockResolvedValue([answer]),
    update: jest.fn().mockResolvedValue(answer),
  };

  return { resolver: new AnswerResolver(answerService as never, undefined as never), answerService };
}

describe('createAnswer', () => {
  it('stores an answer of exactly the limit', async () => {
    const { resolver, answerService } = makeResolver();

    await resolver.createAnswer(CTX, { answer: AT_CAP, questionId: QUESTION_ID });

    expect(answerService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: AT_CAP }),
    );
  });

  it('refuses one character over, with a 400, before anything is stored', async () => {
    const { resolver, answerService } = makeResolver();

    const refused = resolver.createAnswer(CTX, { answer: OVER_CAP, questionId: QUESTION_ID });

    await expect(refused).rejects.toBeInstanceOf(BadRequestException);
    await expect(refused).rejects.toThrow('Answer text must be 5000 characters or less');
    expect(answerService.create).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['whitespace of every kind', ' \n\t \r\n '],
  ])('refuses a %s answer with a 400 rather than letting the CHECK constraint 500', async (_name, text) => {
    const { resolver, answerService } = makeResolver();

    const refused = resolver.createAnswer(CTX, { answer: text, questionId: QUESTION_ID });

    await expect(refused).rejects.toBeInstanceOf(BadRequestException);
    await expect(refused).rejects.toThrow('Answer text is required');
    expect(answerService.create).not.toHaveBeenCalled();
  });
});

describe('createAnswers', () => {
  it('refuses the whole batch when any one answer is over the limit, storing none of it', async () => {
    const { resolver, answerService } = makeResolver();

    const refused = resolver.createAnswers(CTX, [
      { answer: 'Thai', questionId: QUESTION_ID },
      { answer: OVER_CAP, questionId: QUESTION_ID },
    ]);

    await expect(refused).rejects.toBeInstanceOf(BadRequestException);
    expect(answerService.createMany).not.toHaveBeenCalled();
  });

  it('stores a batch that is all within the limit', async () => {
    const { resolver, answerService } = makeResolver();

    await resolver.createAnswers(CTX, [
      { answer: 'Thai', questionId: QUESTION_ID },
      { answer: AT_CAP, questionId: QUESTION_ID },
    ]);

    expect(answerService.createMany).toHaveBeenCalledTimes(1);
  });
});

describe('updateAnswer', () => {
  const id = GlobalUID.encode('answer', ANSWER_ID);

  it('stores an edit of exactly the limit', async () => {
    const { resolver, answerService } = makeResolver();

    await resolver.updateAnswer(CTX, { id, answer: AT_CAP });

    expect(answerService.update).toHaveBeenCalledWith(expect.anything(), ANSWER_ID, { text: AT_CAP });
  });

  it('refuses an edit one character over, with a 400, before anything is rewritten', async () => {
    const { resolver, answerService } = makeResolver();

    const refused = resolver.updateAnswer(CTX, { id, answer: OVER_CAP });

    await expect(refused).rejects.toBeInstanceOf(BadRequestException);
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('refuses a blank edit', async () => {
    const { resolver, answerService } = makeResolver();

    await expect(resolver.updateAnswer(CTX, { id, answer: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(answerService.update).not.toHaveBeenCalled();
  });
});
