import type { LoggerService } from '@ci/common/logging';
import type { OllamaService } from '@ci/domains/llm';

import { ConceptExtractionService } from '../ConceptExtractionService';

const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

const context = { userId: 'user-1' } as never;

function makeService(chat: jest.Mock) {
  return new ConceptExtractionService({ chat } as unknown as OllamaService, logger);
}

/** Shape the OllamaService.chat contract: a JSON document inside message.content. */
function reply(body: unknown) {
  return { message: { content: JSON.stringify(body) } };
}

describe('ConceptExtractionService', () => {
  it('names the concept rather than echoing the answer', async () => {
    const chat = jest.fn().mockResolvedValue(
      reply({
        hasPreference: true,
        name: 'Tacos',
        category: 'Food',
        relationshipType: 'PREFERS',
        strength: 0.9,
      }),
    );

    const result = await makeService(chat).extract(context, {
      questionText: 'Choosing between tacos, sushi or pizza, which is your favourite?',
      answerText: 'Definitely tacos, I could eat them every day',
    });

    expect(result).toEqual({
      name: 'Tacos',
      category: 'food', // lowercased to match onboarding's convention
      relationshipType: 'PREFERS',
      strength: 0.9,
    });
  });

  it('passes both the question and the answer to the model', async () => {
    const chat = jest.fn().mockResolvedValue(reply({ hasPreference: false }));

    await makeService(chat).extract(context, {
      questionText: 'What is your favourite cuisine?',
      answerText: 'Mexican',
    });

    const prompt = chat.mock.calls[0][1][0].content as string;
    expect(prompt).toContain('What is your favourite cuisine?');
    expect(prompt).toContain('Mexican');
  });

  it('returns null when the answer states a trait rather than a preference', async () => {
    const chat = jest.fn().mockResolvedValue(reply({ hasPreference: false }));

    const result = await makeService(chat).extract(context, {
      questionText: 'When making decisions, do you rely on logic or intuition?',
      answerText:
        'I fundamentally rely on logic and detailed analysis because my goal is always to create optimal structure.',
    });

    expect(result).toBeNull();
  });

  describe('the model is not trusted to stay brief', () => {
    // The failure being guarded is a Concept named with 120 characters of a
    // paragraph. A prompt asking for three words is not a constraint.
    it('rejects a name over three words', async () => {
      const chat = jest.fn().mockResolvedValue(
        reply({
          hasPreference: true,
          name: 'Being the proactive architect of structure',
          category: 'other',
          relationshipType: 'PREFERS',
          strength: 0.8,
        }),
      );

      expect(await makeService(chat).extract(context, { questionText: null, answerText: 'x' })).toBeNull();
    });

    it('rejects a name over 64 characters', async () => {
      const chat = jest.fn().mockResolvedValue(
        reply({
          hasPreference: true,
          name: 'a'.repeat(65),
          category: 'other',
          relationshipType: 'PREFERS',
          strength: 0.8,
        }),
      );

      expect(await makeService(chat).extract(context, { questionText: null, answerText: 'x' })).toBeNull();
    });

    // The grammar's maxLength is 120, zod's is 64, and that gap is deliberate:
    // constrained decoding truncates AT its limit rather than answering briefly,
    // so a value cut at the grammar boundary must still be rejected here. If the
    // two limits are ever equalised, a mid-word fragment reaches the graph and
    // this test is what fails.
    it('rejects a name truncated at the grammar limit', async () => {
      const chat = jest.fn().mockResolvedValue(
        reply({
          hasPreference: true,
          name: 'Systemic optimisation of structural analysis frameworks for complex vari',
          category: 'other',
          relationshipType: 'PREFERS',
          strength: 0.8,
        }),
      );

      expect(await makeService(chat).extract(context, { questionText: null, answerText: 'x' })).toBeNull();
    });

    it('rejects a relationship type outside the pair the graph queries', async () => {
      const chat = jest.fn().mockResolvedValue(
        reply({
          hasPreference: true,
          name: 'Tacos',
          category: 'food',
          relationshipType: 'INTERESTED_IN',
          strength: 0.8,
        }),
      );

      expect(await makeService(chat).extract(context, { questionText: null, answerText: 'x' })).toBeNull();
    });
  });

  describe('failure never falls back to the answer text', () => {
    // Falling back to the raw answer IS the bug this service replaces: losing a
    // promotion is recoverable (the answer stays in ci.answers and the next
    // hydration pass sees it again); a poisoned graph node is not.
    it('returns null when the model call throws', async () => {
      const chat = jest.fn().mockRejectedValue(new Error('ollama unreachable'));

      const result = await makeService(chat).extract(context, {
        questionText: 'Favourite food?',
        answerText: 'Tacos',
      });

      expect(result).toBeNull();
    });

    it('returns null when the model returns unparseable content', async () => {
      const chat = jest.fn().mockResolvedValue({ message: { content: 'not json at all' } });

      const result = await makeService(chat).extract(context, {
        questionText: 'Favourite food?',
        answerText: 'Tacos',
      });

      expect(result).toBeNull();
    });

    it('does not call the model for empty answers', async () => {
      const chat = jest.fn();

      expect(await makeService(chat).extract(context, { questionText: 'q', answerText: '   ' })).toBeNull();
      expect(chat).not.toHaveBeenCalled();
    });
  });

  it('defaults strength when the model omits it, rather than asserting the old flat 0.6', async () => {
    const chat = jest
      .fn()
      .mockResolvedValue(
        reply({ hasPreference: true, name: 'Hiking', category: 'activity', relationshipType: 'PREFERS' }),
      );

    const result = await makeService(chat).extract(context, { questionText: 'q', answerText: 'a' });

    expect(result?.strength).toBe(0.8);
  });
});
