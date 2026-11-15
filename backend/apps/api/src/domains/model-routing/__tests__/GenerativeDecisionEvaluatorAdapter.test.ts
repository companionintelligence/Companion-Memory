import {
  DECISION_KEEP_ALIVE,
  GenerativeDecisionEvaluatorAdapter,
  MAX_CHOICE_CANDIDATES,
  parseChoiceDistribution,
  type DecisionChatModel,
} from '../services/GenerativeDecisionEvaluatorAdapter';

type ChatOptions = Parameters<DecisionChatModel['chat']>[2];
type ChatMessages = Parameters<DecisionChatModel['chat']>[1];

const CHOICES = [
  { id: 'a', label: 'contacts lookup' },
  { id: 'b', label: 'photos search' },
];

function modelWith(chat: jest.Mock): DecisionChatModel {
  return { chat } as unknown as DecisionChatModel;
}

/** A chat double whose every call resolves with the given completion. */
function replyWith(content: string | null | undefined, doneReason = 'stop'): jest.Mock {
  return jest.fn().mockResolvedValue({ done_reason: doneReason, message: { content } });
}

function adapterReplying(content: string | null | undefined, doneReason = 'stop') {
  return new GenerativeDecisionEvaluatorAdapter(modelWith(replyWith(content, doneReason)));
}

describe('GenerativeDecisionEvaluatorAdapter', () => {
  describe('valid answers', () => {
    it('parses a strict noul answer and asks the utility tier for JSON with no tools', async () => {
      const chat = replyWith('{"probability":0.8}');
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat));

      await expect(
        adapter.evaluateNoul('move the dentist visit to friday', 'schedule an appointment', 'delete photos'),
      ).resolves.toBe(0.8);

      expect(chat).toHaveBeenCalledTimes(1);
      const [, messages, options] = chat.mock.calls[0] as [unknown, ChatMessages, ChatOptions];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'user' });
      expect(messages[0].content).toContain('"move the dentist visit to friday"');
      expect(options).toMatchObject({ tier: 'utility', enableTools: false, keepAlive: DECISION_KEEP_ALIVE });
      expect(options.format).toMatchObject({ required: ['probability'], additionalProperties: false });
      expect(options.maxOutputTokens).toBeGreaterThan(0);
      expect(options.signal.aborted).toBe(false);
    });

    it('parses a strict choice answer and selects the most probable candidate', async () => {
      const adapter = adapterReplying('{"probabilities":{"a":0.3,"b":0.7}}');

      await expect(adapter.evaluateChoice('find the beach photos', CHOICES)).resolves.toEqual({
        selectedId: 'b',
        probabilities: { a: 0.3, b: 0.7 },
      });
    });

    it('normalises a choice answer whose entries sum slightly off 1', async () => {
      const adapter = adapterReplying('{"probabilities":{"a":0.49,"b":0.5}}');

      const answer = await adapter.evaluateChoice('find the beach photos', CHOICES);

      expect(answer?.selectedId).toBe('b');
      expect(Object.values(answer?.probabilities ?? {}).reduce((sum, value) => sum + value, 0)).toBeCloseTo(
        1,
        10,
      );
    });

    it('breaks a choice tie in favour of the earlier candidate', () => {
      expect(parseChoiceDistribution('{"probabilities":{"a":0.5,"b":0.5}}', ['a', 'b'])?.selectedId).toBe(
        'a',
      );
    });

    it('keeps long states out of the prompt', async () => {
      const chat = replyWith('{"probability":0.5}');
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat));

      await adapter.evaluateNoul('x'.repeat(5_000), 'action', 'negated');

      const [, messages] = chat.mock.calls[0] as [unknown, ChatMessages, ChatOptions];
      expect(messages[0].content.length).toBeLessThan(2_000);
    });
  });

  describe('malformed answers', () => {
    it.each([
      ['plain prose', 'the probability is high'],
      ['truncated JSON', '{"probability":'],
      ['a code fence around valid JSON', '```json\n{"probability":0.5}\n```'],
      ['a JSON array', '[0.5]'],
      ['an empty string', ''],
    ])('returns undefined for %s', async (_label, content) => {
      await expect(adapterReplying(content).evaluateNoul('s', 'a', 'n')).resolves.toBeUndefined();
      await expect(adapterReplying(content).evaluateChoice('s', CHOICES)).resolves.toBeUndefined();
    });

    it('returns undefined when the reply has no content', async () => {
      await expect(adapterReplying(null).evaluateNoul('s', 'a', 'n')).resolves.toBeUndefined();
      await expect(adapterReplying(undefined).evaluateChoice('s', CHOICES)).resolves.toBeUndefined();
    });

    it.each([
      ['the key is misspelt', '{"p":0.5}'],
      ['the value is a string', '{"probability":"0.5"}'],
      ['an extra key is present', '{"probability":0.5,"reason":"seems likely"}'],
      ['the object is empty', '{}'],
    ])('rejects a noul reply where %s', async (_label, content) => {
      await expect(adapterReplying(content).evaluateNoul('s', 'a', 'n')).resolves.toBeUndefined();
    });

    it.each([
      ['a candidate is missing', '{"probabilities":{"a":1}}'],
      ['an unknown candidate is present', '{"probabilities":{"a":0.5,"b":0.25,"c":0.25}}'],
      ['the probabilities are a list', '{"probabilities":[0.5,0.5]}'],
      ['a value is a string', '{"probabilities":{"a":"0.5","b":0.5}}'],
      ['the top-level key is wrong', '{"scores":{"a":0.5,"b":0.5}}'],
    ])('rejects a choice reply where %s', async (_label, content) => {
      await expect(adapterReplying(content).evaluateChoice('s', CHOICES)).resolves.toBeUndefined();
    });

    it('returns undefined when the reply stopped at its output cap', async () => {
      await expect(
        adapterReplying('{"probability":0.', 'length').evaluateNoul('s', 'a', 'n'),
      ).resolves.toBeUndefined();
    });
  });

  describe('out-of-range answers', () => {
    it.each(['{"probability":1.2}', '{"probability":-0.1}'])(
      'rejects the noul probability %s',
      async (content) => {
        await expect(adapterReplying(content).evaluateNoul('s', 'a', 'n')).resolves.toBeUndefined();
      },
    );

    it('rejects choice values outside [0, 1]', async () => {
      await expect(
        adapterReplying('{"probabilities":{"a":1.5,"b":-0.5}}').evaluateChoice('s', CHOICES),
      ).resolves.toBeUndefined();
    });

    it('rejects a choice distribution that is far from summing to 1', async () => {
      await expect(
        adapterReplying('{"probabilities":{"a":0.9,"b":0.9}}').evaluateChoice('s', CHOICES),
      ).resolves.toBeUndefined();
    });
  });

  describe('timeouts and failures', () => {
    it('returns undefined when the model never answers, even if it ignores the abort signal', async () => {
      const chat = jest.fn(() => new Promise<never>(() => undefined));
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat), { timeoutMs: 20 });

      await expect(adapter.evaluateNoul('s', 'a', 'n')).resolves.toBeUndefined();

      const options = (chat.mock.calls[0] as unknown[])[2] as ChatOptions;
      expect(options.signal.aborted).toBe(true);
      expect(options.firstResponseTimeoutMs).toBe(20);
    });

    it('returns undefined when the model honours the abort signal', async () => {
      const chat = jest.fn(
        (_context: unknown, _messages: unknown, options: ChatOptions) =>
          new Promise<never>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat), { timeoutMs: 20 });

      await expect(adapter.evaluateChoice('s', CHOICES)).resolves.toBeUndefined();
    });

    it('returns undefined and logs the reason when the llm call rejects', async () => {
      const chat = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      const logger = { warn: jest.fn() };
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat), { logger });

      await expect(adapter.evaluateNoul('s', 'a', 'n')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    });

    it('does not call the model for choice sets it cannot express', async () => {
      const chat = replyWith('{"probabilities":{}}');
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat));
      const tooMany = Array.from({ length: MAX_CHOICE_CANDIDATES + 1 }, (_, i) => ({
        id: `c${i}`,
        label: `label ${i}`,
      }));

      await expect(adapter.evaluateChoice('s', tooMany)).resolves.toBeUndefined();
      await expect(
        adapter.evaluateChoice('s', [
          { id: 'a', label: 'x' },
          { id: 'a', label: 'y' },
        ]),
      ).resolves.toBeUndefined();
      await expect(adapter.evaluateChoice('s', [])).resolves.toBeUndefined();
      expect(chat).not.toHaveBeenCalled();
    });
  });
});
