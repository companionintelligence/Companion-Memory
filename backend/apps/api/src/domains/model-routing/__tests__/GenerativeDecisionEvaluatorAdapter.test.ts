import {
  DECISION_KEEP_ALIVE,
  GenerativeDecisionEvaluatorAdapter,
  MAX_CHOICE_CANDIDATES,
  MAX_DECISION_STATE_CHARS,
  parseChoiceDistribution,
  type DecisionChatModel,
} from '../services/GenerativeDecisionEvaluatorAdapter';

type ChatOptions = Parameters<DecisionChatModel['chat']>[2];
type ChatMessages = Parameters<DecisionChatModel['chat']>[1];
type ChoiceSchema = { properties: { probabilities: { properties: Record<string, unknown> } } };

// Choice answers are keyed by candidate number, so these ids only show up in the parser's mapping.
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

/** A 36-character id in the shape of a UUID, distinct for each index. */
function uuidLikeId(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-1111-4111-8111-${index.toString(16).padStart(12, '0')}`;
}

describe('GenerativeDecisionEvaluatorAdapter', () => {
  describe('valid answers', () => {
    it('parses a strict noul answer and asks the utility tier, at interactive priority, for JSON with no tools', async () => {
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
      expect(options).toMatchObject({
        tier: 'utility',
        enableTools: false,
        keepAlive: DECISION_KEEP_ALIVE,
        priority: 'interactive',
      });
      expect(options.format).toMatchObject({ required: ['probability'], additionalProperties: false });
      expect(options.maxOutputTokens).toBeGreaterThan(0);
      expect(options.signal.aborted).toBe(false);
    });

    it('parses a strict choice answer and selects the most probable candidate', async () => {
      const adapter = adapterReplying('{"probabilities":{"1":0.3,"2":0.7}}');

      await expect(adapter.evaluateChoice('find the beach photos', CHOICES)).resolves.toEqual({
        selectedId: 'b',
        probabilities: { a: 0.3, b: 0.7 },
      });
    });

    it('normalises a choice answer whose entries sum slightly off 1', async () => {
      const adapter = adapterReplying('{"probabilities":{"1":0.49,"2":0.5}}');

      const answer = await adapter.evaluateChoice('find the beach photos', CHOICES);

      expect(answer?.selectedId).toBe('b');
      expect(Object.values(answer?.probabilities ?? {}).reduce((sum, value) => sum + value, 0)).toBeCloseTo(
        1,
        10,
      );
    });

    it('breaks a choice tie in favour of the earlier candidate', () => {
      expect(parseChoiceDistribution('{"probabilities":{"1":0.5,"2":0.5}}', ['a', 'b'])?.selectedId).toBe(
        'a',
      );
    });

    it('names choice candidates by number in the request, and never sends their ids', async () => {
      const chat = replyWith('{"probabilities":{"1":0.5,"2":0.5}}');
      const ids = [uuidLikeId(1), uuidLikeId(2)];

      await new GenerativeDecisionEvaluatorAdapter(modelWith(chat)).evaluateChoice(
        'find the beach photos',
        ids.map((id) => ({ id, label: 'photos' })),
      );

      const [, messages, options] = chat.mock.calls[0] as [unknown, ChatMessages, ChatOptions];
      const schema = options.format as ChoiceSchema;
      expect(Object.keys(schema.properties.probabilities.properties)).toEqual(['1', '2']);
      for (const id of ids) {
        expect(messages[0].content).not.toContain(id);
      }
    });

    it('clips a long state to its cap in the prompt', async () => {
      const chat = replyWith('{"probability":0.5}');
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat));

      await adapter.evaluateNoul('x'.repeat(5_000), 'action', 'negated');

      const [, messages] = chat.mock.calls[0] as [unknown, ChatMessages, ChatOptions];
      expect(messages[0].content).toContain('x'.repeat(MAX_DECISION_STATE_CHARS));
      expect(messages[0].content).not.toContain('x'.repeat(MAX_DECISION_STATE_CHARS + 1));
    });

    it('answers the largest allowed choice set with 36-character ids inside its output budget', async () => {
      const candidates = Array.from({ length: MAX_CHOICE_CANDIDATES }, (_, index) => ({
        id: uuidLikeId(index),
        label: `label ${index}`,
      }));
      const chat = jest.fn(async (_context: unknown, _messages: unknown, options: ChatOptions) => {
        // A conforming answer: one entry per candidate, keyed the way the request's schema names them.
        const keys = Object.keys((options.format as ChoiceSchema).properties.probabilities.properties);
        const content = JSON.stringify({
          probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])),
        });

        // One character is at least one token, so an answer longer than the budget would be cut off.
        return content.length <= options.maxOutputTokens
          ? { done_reason: 'stop', message: { content } }
          : { done_reason: 'length', message: { content: content.slice(0, options.maxOutputTokens) } };
      });

      const answer = await new GenerativeDecisionEvaluatorAdapter(modelWith(chat)).evaluateChoice(
        'find the beach photos',
        candidates,
      );

      expect(answer).toBeDefined();
      expect(Object.keys(answer?.probabilities ?? {})).toEqual(candidates.map((candidate) => candidate.id));
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
      ['a candidate is missing', '{"probabilities":{"1":1}}'],
      ['an unknown candidate is present', '{"probabilities":{"1":0.5,"2":0.25,"3":0.25}}'],
      ['the answer is keyed by candidate id', '{"probabilities":{"a":0.5,"b":0.5}}'],
      ['the probabilities are a list', '{"probabilities":[0.5,0.5]}'],
      ['a value is a string', '{"probabilities":{"1":"0.5","2":0.5}}'],
      ['the top-level key is wrong', '{"scores":{"1":0.5,"2":0.5}}'],
    ])('rejects a choice reply where %s', async (_label, content) => {
      await expect(adapterReplying(content).evaluateChoice('s', CHOICES)).resolves.toBeUndefined();
    });

    it('returns undefined, and says so, when a complete-looking reply stopped at its output cap', async () => {
      const logger = { warn: jest.fn() };
      const noul = new GenerativeDecisionEvaluatorAdapter(
        modelWith(replyWith('{"probability":0.5}', 'length')),
        { logger },
      );
      const choice = new GenerativeDecisionEvaluatorAdapter(
        modelWith(replyWith('{"probabilities":{"1":0.3,"2":0.7}}', 'length')),
        { logger },
      );

      await expect(noul.evaluateNoul('s', 'a', 'n')).resolves.toBeUndefined();
      await expect(choice.evaluateChoice('s', CHOICES)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('output cap'));
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
        adapterReplying('{"probabilities":{"1":1.5,"2":-0.5}}').evaluateChoice('s', CHOICES),
      ).resolves.toBeUndefined();
    });

    it('rejects a choice distribution that is far from summing to 1', async () => {
      await expect(
        adapterReplying('{"probabilities":{"1":0.9,"2":0.9}}').evaluateChoice('s', CHOICES),
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

    it('returns undefined when the model honours the abort signal, and the signal fired', async () => {
      const chat = jest.fn(
        (_context: unknown, _messages: unknown, options: ChatOptions) =>
          new Promise<never>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat), { timeoutMs: 20 });

      await expect(adapter.evaluateChoice('s', CHOICES)).resolves.toBeUndefined();

      expect(chat).toHaveBeenCalledTimes(1);
      const options = (chat.mock.calls[0] as unknown[])[2] as ChatOptions;
      expect(options.signal.aborted).toBe(true);
    });

    it('returns undefined and logs the reason when the llm call rejects', async () => {
      const chat = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      const logger = { warn: jest.fn() };
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat), { logger });

      await expect(adapter.evaluateNoul('s', 'a', 'n')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    });

    it('resolves to undefined, without calling the model, for input it cannot build a prompt from', async () => {
      const chat = replyWith('{"probability":0.5}');
      const logger = { warn: jest.fn() };
      const adapter = new GenerativeDecisionEvaluatorAdapter(modelWith(chat), { logger });

      await expect(adapter.evaluateNoul(undefined as unknown as string, 'a', 'n')).resolves.toBeUndefined();
      await expect(
        adapter.evaluateChoice('s', null as unknown as ReadonlyArray<{ id: string; label: string }>),
      ).resolves.toBeUndefined();
      await expect(
        adapter.evaluateChoice('s', [{ id: 'a', label: undefined as unknown as string }]),
      ).resolves.toBeUndefined();

      expect(chat).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(3);
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
