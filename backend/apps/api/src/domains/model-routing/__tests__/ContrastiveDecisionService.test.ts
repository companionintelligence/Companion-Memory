import { type RequestContext } from '@ci/common/context';
import { type EmbeddingGenerationService } from '@ci/common/embeddings';
import { type PersonService, type UserContextService } from '@ci/domains/memory';

import { ModelRoutingController } from '../controllers/ModelRoutingController';
import {
  ActionVectorArena,
  ContrastiveDecisionService,
  cosineSimilarity,
  deterministicTextEmbedding,
  normalizeVector,
} from '../services/ContrastiveDecisionService';
import { ModelTierRouter } from '../services/ModelTierRouter';

describe('ContrastiveDecisionService (CLM System 1 + Generative System 2)', () => {
  it('ActionVectorArena caches normalized vectors and evicts LRU entries at capacity', () => {
    const arena = new ActionVectorArena(2);
    const v1 = arena.set('intent.one', [3, 4]);
    expect(v1[0]).toBeCloseTo(0.6, 5);
    expect(v1[1]).toBeCloseTo(0.8, 5);

    arena.set('intent.two', [1, 0]);
    // Touch intent.one so intent.two becomes oldest
    expect(arena.get('intent.one')).toBeDefined();

    arena.set('intent.three', [0, 1]);
    expect(arena.size).toBe(2);
    expect(arena.get('intent.one')).toBeDefined();
    expect(arena.get('intent.two')).toBeUndefined();
    expect(arena.get('intent.three')).toBeDefined();
  });

  it('noul computes binary probability P(yes | state, action) in contrastive mode', async () => {
    const service = new ContrastiveDecisionService();
    const res = await service.noul(
      'search my calendar events and meetings for tomorrow',
      'search calendar events and meetings',
      {
        negatedAction: 'delete all database backups permanently',
        engine: 'contrastive',
      },
    );

    expect(res.primitive).toBe('noul');
    expect(res.engineUsed).toBe('contrastive');
    expect(res.probability).toBeGreaterThan(0.7);
    expect(res.decision).toBe(true);
    expect(res.positiveSimilarity).toBeGreaterThan(res.negativeSimilarity);
  });

  it('choice selects the closest intent candidate and caches candidate embeddings in ActionVectorArena', async () => {
    const embedMock = {
      generateEmbedding: jest.fn(async (text: string) => deterministicTextEmbedding(text)),
    } as unknown as EmbeddingGenerationService;

    const service = new ContrastiveDecisionService(embedMock);
    const candidates = [
      { id: 'calendar.search', label: 'search calendar events meetings schedule' },
      { id: 'photos.find', label: 'find family vacation beach photos' },
      { id: 'contacts.lookup', label: 'lookup phone number and email address for person' },
    ];

    const first = await service.choice('find family vacation photos from the beach', candidates, {
      engine: 'contrastive',
    });
    expect(first.selectedId).toBe('photos.find');
    expect(first.engineUsed).toBe('contrastive');
    expect(service.getArenaStats().size).toBe(3);
    // 1 state embedding + 3 candidate embeddings
    expect(embedMock.generateEmbedding).toHaveBeenCalledTimes(4);

    // Second call with the same candidates only embeds the new state (1 call)!
    const second = await service.choice('search my calendar schedule and meetings', candidates, {
      engine: 'contrastive',
    });
    expect(second.selectedId).toBe('calendar.search');
    expect(embedMock.generateEmbedding).toHaveBeenCalledTimes(5);
  });

  it('hybrid mode escalates to the generative evaluator when contrastive margin is below threshold', async () => {
    const service = new ContrastiveDecisionService();
    const evaluateChoice = jest.fn(async () => ({
      selectedId: 'b',
      probabilities: { a: 0.1, b: 0.9 },
    }));
    service.setGenerativeEvaluator({ evaluateChoice });

    // Force escalation by setting escalationMarginThreshold = 1.0
    const res = await service.choice(
      'ambiguous query',
      [
        { id: 'a', label: 'ambiguous option alpha' },
        { id: 'b', label: 'ambiguous option beta' },
      ],
      {
        engine: 'hybrid',
        escalationMarginThreshold: 1.0,
      },
    );

    expect(evaluateChoice).toHaveBeenCalledTimes(1);
    expect(res.engineUsed).toBe('hybrid');
    expect(res.escalatedToGenerative).toBe(true);
    expect(res.selectedId).toBe('b');
  });

  it('score computes weighted multi-criterion rubric scores', async () => {
    const service = new ContrastiveDecisionService();
    const res = await service.score(
      'private local-first encrypted memory appliance on device',
      [
        {
          name: 'privacy',
          positive: 'private local-first encrypted on device',
          negative: 'public unencrypted third-party telemetry',
          weight: 2,
        },
        {
          name: 'relevance',
          positive: 'memory appliance',
          negative: 'unrelated gaming console',
          weight: 1,
        },
      ],
      { engine: 'contrastive' },
    );

    expect(res.primitive).toBe('score');
    expect(res.criteria).toHaveLength(2);
    expect(res.compositeScore).toBeGreaterThan(0.6);
  });

  it('rank orders candidates by similarity and reports arena hits/misses', async () => {
    const service = new ContrastiveDecisionService();
    const candidates = [
      { id: 'c1', text: 'import google takeout archive zip' },
      { id: 'c2', text: 'send federated ask to linked peer' },
      { id: 'c3', text: 'configure ollama inference port' },
    ];

    const first = await service.rank('send federated ask to peer', candidates, {
      engine: 'contrastive',
      topK: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(first.items[0].id).toBe('c2');
    expect(first.items[0].rank).toBe(1);
    expect(first.arenaMissCount).toBe(3);
    expect(first.arenaHitCount).toBe(0);

    const second = await service.rank('import takeout archive', candidates, {
      engine: 'contrastive',
    });
    expect(second.items[0].id).toBe('c1');
    expect(second.arenaHitCount).toBe(3);
    expect(second.arenaMissCount).toBe(0);
  });

  it('honors user settings when contrastive or generative engines are toggled off in Settings', async () => {
    let plannerState: Record<string, unknown> = {
      contrastive_decision_enabled: false,
      generative_decision_enabled: true,
    };

    const userContextService = {
      getSelfIdentity: jest.fn(async () => ({ entityId: 'self-1' })),
    } as unknown as UserContextService;
    const personService = {
      findById: jest.fn(async () => ({ properties: { planner: plannerState } })),
    } as unknown as PersonService;

    const service = new ContrastiveDecisionService(undefined, personService, userContextService);

    // 1. Contrastive disabled, Generative enabled -> 'auto' routes to 'generative'
    const genRes = await service.noul('check calendar schedule', 'check calendar schedule', {
      userId: 'user-1',
      engine: 'auto',
    });
    expect(genRes.engineUsed).toBe('generative');

    // Explicit 'contrastive' request when contrastive is disabled returns 'disabled'
    const blockedContrastive = await service.noul('check calendar', 'check calendar', {
      userId: 'user-1',
      engine: 'contrastive',
    });
    expect(blockedContrastive.engineUsed).toBe('disabled');

    // 2. Both disabled -> 'auto' returns 'disabled'
    plannerState = {
      contrastive_decision_enabled: false,
      generative_decision_enabled: false,
    };
    const bothOff = await service.choice('check calendar', ['a', 'b'], {
      userId: 'user-1',
      engine: 'auto',
    });
    expect(bothOff.engineUsed).toBe('disabled');
    expect(bothOff.selectedId).toBeNull();
  });

  it('ModelRoutingController exposes /model-routing/decide, /model-routing/rank, and /model-routing/arena', async () => {
    const router = new ModelTierRouter();
    const decisionService = new ContrastiveDecisionService();
    const controller = new ModelRoutingController(router, decisionService);
    const ctx = { userId: 'user-1' } as RequestContext;

    const decideRes = await controller.decide(ctx, {
      primitive: 'choice',
      state: 'lookup peer link trust tier',
      candidates: [
        { id: 'peers.list', label: 'lookup peer link trust tier' },
        { id: 'import.run', label: 'upload archive zip file' },
      ],
      engine: 'contrastive',
    });
    expect(decideRes.primitive).toBe('choice');
    if (decideRes.primitive === 'choice') {
      expect(decideRes.selectedId).toBe('peers.list');
    }

    const rankRes = await controller.rank(ctx, {
      query: 'upload archive zip file',
      candidates: [
        { id: 'peers.list', text: 'lookup peer link trust tier' },
        { id: 'import.run', text: 'upload archive zip file' },
      ],
      topK: 1,
      engine: 'contrastive',
    });
    expect(rankRes.items).toHaveLength(1);
    expect(rankRes.items[0].id).toBe('import.run');
    expect(controller.getArena().size).toBeGreaterThanOrEqual(2);
  });

  it('normalizeVector and cosineSimilarity handle zero vectors safely', () => {
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
