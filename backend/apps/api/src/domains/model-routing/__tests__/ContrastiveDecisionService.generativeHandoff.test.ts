import { ContrastiveDecisionService } from '../services/ContrastiveDecisionService';
import {
  GenerativeDecisionEvaluatorAdapter,
  type DecisionChatModel,
} from '../services/GenerativeDecisionEvaluatorAdapter';

const STATE = 'call the dentist about the appointment next week';
const ACTION = 'schedule an appointment';
const NEGATED = 'delete all photos';
const CANDIDATES = [
  { id: 'calendar', label: 'schedule calendar appointment' },
  { id: 'photos', label: 'delete old photos' },
];

describe('ContrastiveDecisionService with a generative evaluator', () => {
  describe('an evaluator answer that cannot be used', () => {
    it.each([
      ['answers undefined', async () => undefined],
      [
        'throws',
        async () => {
          throw new Error('model unavailable');
        },
      ],
      ['answers outside [0, 1]', async () => 1.4],
      ['answers NaN', async () => Number.NaN],
    ])('noul falls back to the word-overlap score when the evaluator %s', async (_label, evaluateNoul) => {
      const lexical = await new ContrastiveDecisionService().noul(STATE, ACTION, {
        engine: 'generative',
        negatedAction: NEGATED,
      });

      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator({ evaluateNoul });
      const res = await service.noul(STATE, ACTION, { engine: 'generative', negatedAction: NEGATED });

      expect(res.probability).toBe(lexical.probability);
      expect(Number.isFinite(res.probability)).toBe(true);
    });

    it.each([
      ['answers undefined', async () => undefined],
      ['omits a candidate', async () => ({ selectedId: 'calendar', probabilities: { calendar: 0.9 } })],
      [
        'throws',
        async () => {
          throw new Error('timeout');
        },
      ],
    ])(
      'choice falls back to the word-overlap ranking when the evaluator %s',
      async (_label, evaluateChoice) => {
        const lexical = await new ContrastiveDecisionService().choice(STATE, CANDIDATES, {
          engine: 'generative',
        });

        const service = new ContrastiveDecisionService();
        service.setGenerativeEvaluator({ evaluateChoice });
        const res = await service.choice(STATE, CANDIDATES, { engine: 'generative' });

        expect(res.selectedId).toBe(lexical.selectedId);
        expect(res.candidates).toEqual(lexical.candidates);
      },
    );
  });

  describe('hybrid escalation', () => {
    it('a hybrid decision with an unclear score calls the LLM evaluator exactly once', async () => {
      const chat = jest
        .fn()
        .mockResolvedValue({ done_reason: 'stop', message: { content: '{"probability":0.9}' } });
      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator(
        new GenerativeDecisionEvaluatorAdapter({ chat } as unknown as DecisionChatModel),
      );

      // An escalation threshold of 1 is above any contrastive margin, so the score always counts as unclear.
      const res = await service.noul(STATE, ACTION, {
        engine: 'hybrid',
        negatedAction: NEGATED,
        escalationMarginThreshold: 1,
      });

      expect(chat).toHaveBeenCalledTimes(1);
      expect(res.engineUsed).toBe('hybrid');

      const contrastive = await new ContrastiveDecisionService().noul(STATE, ACTION, {
        engine: 'contrastive',
        negatedAction: NEGATED,
      });
      expect(res.probability).toBeCloseTo(0.5 * contrastive.probability + 0.5 * 0.9, 10);
    });

    it('a hybrid decision with a clear score does not call the LLM', async () => {
      const chat = jest.fn();
      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator(
        new GenerativeDecisionEvaluatorAdapter({ chat } as unknown as DecisionChatModel),
      );

      // A threshold of 0 is never reached, so the contrastive score stands.
      const res = await service.noul(STATE, ACTION, {
        engine: 'hybrid',
        negatedAction: NEGATED,
        escalationMarginThreshold: 0,
      });

      expect(chat).not.toHaveBeenCalled();
      expect(res.engineUsed).toBe('contrastive');
    });

    it('a hybrid decision whose LLM answer is unusable still returns a finite probability', async () => {
      const chat = jest.fn().mockResolvedValue({ done_reason: 'stop', message: { content: 'not json' } });
      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator(
        new GenerativeDecisionEvaluatorAdapter({ chat } as unknown as DecisionChatModel),
      );

      const res = await service.noul(STATE, ACTION, {
        engine: 'hybrid',
        negatedAction: NEGATED,
        escalationMarginThreshold: 1,
      });

      expect(chat).toHaveBeenCalledTimes(1);
      expect(Number.isFinite(res.probability)).toBe(true);
    });
  });
});
