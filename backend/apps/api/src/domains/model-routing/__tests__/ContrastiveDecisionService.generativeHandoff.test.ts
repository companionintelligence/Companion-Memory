import type { HbpeService } from '@ci/domains/predictions';

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
const RANK_CANDIDATES = [
  { id: 'calendar', text: 'schedule calendar appointment' },
  { id: 'photos', text: 'delete old photos' },
  { id: 'contacts', text: 'look up a contact' },
];
const SCORE_CRITERIA = [
  { name: 'books', positive: ACTION, negative: NEGATED, weight: 2 },
  { name: 'tidy', positive: 'delete old photos', weight: 1 },
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
      expect(Number.isFinite(res.margin)).toBe(true);
      expect(Number.isFinite(res.negativeSimilarity)).toBe(true);
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

    it('a hybrid decision whose LLM answer is unusable blends in the word-overlap score', async () => {
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
      const contrastive = await new ContrastiveDecisionService().noul(STATE, ACTION, {
        engine: 'contrastive',
        negatedAction: NEGATED,
      });
      const lexical = await new ContrastiveDecisionService().noul(STATE, ACTION, {
        engine: 'generative',
        negatedAction: NEGATED,
      });
      // The lexical value is not 0.5, so a constant stand-in would not match the blend below.
      expect(lexical.probability).not.toBe(0.5);
      expect(res.probability).toBeCloseTo(0.5 * contrastive.probability + 0.5 * lexical.probability, 10);
    });
  });

  describe('score', () => {
    it('weights each criterion probability from the evaluator, one call per criterion', async () => {
      const evaluateNoul = jest.fn(async (_state: string, action: string) => (action === ACTION ? 0.8 : 0.2));
      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator({ evaluateNoul });

      const res = await service.score(STATE, SCORE_CRITERIA, { engine: 'generative' });

      expect(res.engineUsed).toBe('generative');
      expect(res.criteria).toEqual([
        { name: 'books', probability: 0.8, weight: 2 },
        { name: 'tidy', probability: 0.2, weight: 1 },
      ]);
      expect(res.compositeScore).toBeCloseTo((0.8 * 2 + 0.2 * 1) / 3, 10);
      expect(evaluateNoul).toHaveBeenCalledTimes(2);
      expect(evaluateNoul).toHaveBeenNthCalledWith(1, STATE, ACTION, NEGATED);
      expect(evaluateNoul).toHaveBeenNthCalledWith(2, STATE, 'delete old photos', 'not delete old photos');
    });

    it('falls back per criterion to the word-overlap score when the evaluator cannot answer', async () => {
      const baseline = await new ContrastiveDecisionService().score(STATE, SCORE_CRITERIA, {
        engine: 'generative',
      });

      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator({ evaluateNoul: async () => undefined as unknown as number });
      const res = await service.score(STATE, SCORE_CRITERIA, { engine: 'generative' });

      expect(res.criteria).toEqual(baseline.criteria);
      expect(res.compositeScore).toBe(baseline.compositeScore);
    });

    it('returns a disabled, zero result for an empty criteria list', async () => {
      const evaluateNoul = jest.fn();
      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator({ evaluateNoul });

      const res = await service.score(STATE, [], { engine: 'generative' });

      expect(res).toMatchObject({ engineUsed: 'disabled', compositeScore: 0, criteria: [] });
      expect(evaluateNoul).not.toHaveBeenCalled();
    });
  });

  describe('rank', () => {
    it('orders candidates by the evaluator probabilities in generative mode, with one call', async () => {
      const evaluateChoice = jest.fn(async () => ({
        selectedId: 'contacts',
        probabilities: { calendar: 0.2, photos: 0.1, contacts: 0.7 },
      }));
      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator({ evaluateChoice });

      const res = await service.rank(STATE, RANK_CANDIDATES, { engine: 'generative' });

      expect(res.engineUsed).toBe('generative');
      expect(res.items.map((item) => item.id)).toEqual(['contacts', 'calendar', 'photos']);
      expect(res.items.map((item) => item.probability)).toEqual([0.7, 0.2, 0.1]);
      expect(evaluateChoice).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['answers undefined', async () => undefined],
      [
        'throws',
        async () => {
          throw new Error('model unavailable');
        },
      ],
      ['omits a candidate', async () => ({ selectedId: 'calendar', probabilities: { calendar: 1 } })],
    ])(
      'generative rank falls back to the word-overlap order when the evaluator %s',
      async (_label, evaluateChoice) => {
        const baseline = await new ContrastiveDecisionService().rank(STATE, RANK_CANDIDATES, {
          engine: 'generative',
        });

        const service = new ContrastiveDecisionService();
        service.setGenerativeEvaluator({ evaluateChoice });
        const res = await service.rank(STATE, RANK_CANDIDATES, { engine: 'generative' });

        expect(res.engineUsed).toBe('generative');
        expect(res.items).toEqual(baseline.items);
      },
    );

    it('hybrid rank blends the contrastive score and probability with the evaluator probabilities', async () => {
      const evaluated: Record<string, number> = { calendar: 0.2, photos: 0.1, contacts: 0.7 };
      const contrastive = await new ContrastiveDecisionService().rank(STATE, RANK_CANDIDATES, {
        engine: 'contrastive',
      });
      const evaluateChoice = jest.fn(async () => ({ selectedId: 'contacts', probabilities: evaluated }));
      const service = new ContrastiveDecisionService();
      service.setGenerativeEvaluator({ evaluateChoice });

      const res = await service.rank(STATE, RANK_CANDIDATES, { engine: 'hybrid' });

      expect(res.engineUsed).toBe('hybrid');
      expect(evaluateChoice).toHaveBeenCalledTimes(1);
      const base = new Map(contrastive.items.map((item) => [item.id, item]));
      for (const item of res.items) {
        const baseItem = base.get(item.id);
        expect(baseItem).toBeDefined();
        expect(item.score).toBeCloseTo(0.5 * (baseItem?.score ?? 0) + 0.5 * evaluated[item.id], 10);
        expect(item.probability).toBeCloseTo(
          0.5 * (baseItem?.probability ?? 0) + 0.5 * evaluated[item.id],
          10,
        );
      }
    });

    it('hybrid rank does not call the evaluator when the HBPE reranker answers', async () => {
      const hbpe = {
        rerankPassages: jest.fn(
          async (_context: unknown, _query: string, passages: Array<{ id: string }>) => ({
            user_id: 'system',
            results: passages.map((passage, index) => ({
              id: passage.id,
              score: 0.5,
              relevance_probability: 0.5 + index / 10,
              rank: index + 1,
            })),
          }),
        ),
      };
      const evaluateChoice = jest.fn();
      const service = new ContrastiveDecisionService(
        undefined,
        undefined,
        undefined,
        hbpe as unknown as HbpeService,
      );
      service.setGenerativeEvaluator({ evaluateChoice });

      const res = await service.rank(STATE, RANK_CANDIDATES, { engine: 'hybrid' });

      expect(res.engineUsed).toBe('hbpe_system1');
      expect(hbpe.rerankPassages).toHaveBeenCalledTimes(1);
      expect(evaluateChoice).not.toHaveBeenCalled();
    });

    it('hybrid rank with an empty HBPE answer calls the evaluator once, with no margin gate', async () => {
      const hbpe = { rerankPassages: jest.fn(async () => ({ user_id: 'system', results: [] })) };
      const evaluateChoice = jest.fn(async () => ({
        selectedId: 'contacts',
        probabilities: { calendar: 0.2, photos: 0.1, contacts: 0.7 },
      }));
      const service = new ContrastiveDecisionService(
        undefined,
        undefined,
        undefined,
        hbpe as unknown as HbpeService,
      );
      service.setGenerativeEvaluator({ evaluateChoice });

      const res = await service.rank(STATE, RANK_CANDIDATES, { engine: 'hybrid' });

      expect(res.engineUsed).toBe('hybrid');
      expect(evaluateChoice).toHaveBeenCalledTimes(1);
    });
  });
});
