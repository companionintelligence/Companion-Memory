import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EntityResolutionService } from '@ci/domains/entity-resolution';
import type { EventService } from '@ci/domains/events';
import type { GraphExpansionService } from '@ci/domains/graph';
import {
  RETRIEVAL_POLICY_DEFAULTS,
  type RetrievalPolicy,
  type RetrievalPolicyService,
} from '@ci/domains/retrieval-policy';
import type { SearchService } from '@ci/domains/search-next';

import type { AgentMemoryService } from '../AgentMemoryService';
import { RecallService } from '../RecallService';
import type { SerializerService } from '../SerializerService';

/**
 * `RecallService`'s five retrieval knobs used to be module-level literals whose
 * own comments said the tuning loop was being run by hand ("flip the constant
 * (not the call sites) if the benchmark reverses it"). They now come from
 * `ci.retrieval_policy`.
 *
 * The load-bearing half is the first describe: under the fail-open baseline —
 * an appliance whose policy table is empty or unreachable — every call
 * `RecallService` makes carries exactly the arguments it carried before the
 * policy existed. The second describe proves a promoted v2 actually moves them,
 * so the first is not passing because the wiring is inert.
 */
const CONTEXT = { userId: 'user-1' } as unknown as UserServiceContext;

const V2: RetrievalPolicy = {
  version: 2,
  tsRankWeights: { d: 0.05, c: 0.25, b: 0.5, a: 0.9 },
  embeddingBoostFactor: 0.8,
  semanticDistanceThreshold: 0.42,
  semanticMaxResults: 40,
  recallMessageResults: 15,
  recallMessageDistanceFloor: 0.35,
  recallSeedMode: 'hybrid',
  groundedSimilarityFloor: 0.75,
  anchoredDepthMultiplier: 3,
};

function build(policy: RetrievalPolicy = RETRIEVAL_POLICY_DEFAULTS) {
  const search = jest.fn().mockResolvedValue([{ type: 'person', id: 'p1' }]);
  const searchAnchored = jest.fn().mockResolvedValue([]);
  const searchMessages = jest.fn().mockResolvedValue([]);
  const searchService = { search, searchAnchored, searchMessages } as unknown as SearchService;

  const entityResolution = {
    resolve: jest
      .fn()
      .mockImplementation((_ctx: unknown, hits: { type: string; id: string }[]) =>
        Promise.resolve(
          new Map(
            hits.map((hit) => [`${hit.type}:${hit.id}`, { ...hit, entity: { direction: 'outbound' } }]),
          ),
        ),
      ),
  } as unknown as EntityResolutionService;

  const serializer = {
    serialize: jest.fn().mockImplementation((hit: { id: string }) => hit.id),
    reference: jest.fn().mockImplementation((hit: { type: string; id: string }) => ({ ...hit, at: null })),
  } as unknown as SerializerService;

  const graphExpansion = { expand: jest.fn().mockResolvedValue([]) } as unknown as GraphExpansionService;
  const agentMemory = { findByIds: jest.fn().mockResolvedValue([]) } as unknown as AgentMemoryService;
  const events = { send: jest.fn().mockResolvedValue([]) } as unknown as EventService;
  const logger = { setContext() {}, warn() {}, log() {} } as unknown as LoggerService;
  const retrievalPolicy = { get: jest.fn().mockResolvedValue(policy) } as unknown as RetrievalPolicyService;

  const service = new RecallService(
    searchService,
    entityResolution,
    serializer,
    graphExpansion,
    agentMemory,
    events,
    logger,
    retrievalPolicy,
  );

  return { service, search, searchAnchored, searchMessages, retrievalPolicy };
}

describe('RecallService under the fail-open baseline — behaviour is unchanged', () => {
  it('seeds with boosted, exactly as the old SEED_MODE constant did', async () => {
    const { service, search } = build();

    await service.recall(CONTEXT, { query: 'where does Jordan live', maxResults: 5 });

    expect(search).toHaveBeenCalledWith(CONTEXT, expect.objectContaining({ mode: 'boosted' }));
  });

  it('asks the message channel for 10 fragments at the SearchService default floor', async () => {
    const { service, searchMessages } = build();

    await service.recall(CONTEXT, { query: 'where does Jordan live', maxResults: 5 });

    // The old constants were MESSAGE_RESULTS = 10 and
    // `MESSAGE_DISTANCE_FLOOR: number | undefined = undefined`. A policy NULL
    // has to reach searchMessages as `undefined`, not as `null` — `null` would
    // defeat the parameter default and bind NULL into the SQL floor, which
    // silently returns no rows.
    expect(searchMessages).toHaveBeenCalledWith(CONTEXT, 'where does Jordan live', 10, undefined);
  });

  it('grounded recall cuts the anchored channel at 2x depth and the semantic one at 0.7 similarity', async () => {
    const { service, search, searchAnchored } = build();

    await service.recall(
      CONTEXT,
      { query: 'What sports do you follow?', maxResults: 5 },
      { strategy: 'grounded' },
    );

    expect(searchAnchored).toHaveBeenCalledWith(
      CONTEXT,
      'What sports do you follow?',
      expect.objectContaining({ maxResults: 10 }),
    );
    // 1 - 0.7. Written as the subtraction so a floating-point change in the
    // knob is visible here rather than being rounded away by the assertion.
    expect(search).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({ mode: 'semantic', distanceThreshold: 1 - 0.7 }),
    );
  });
});

describe('RecallService under a promoted v2', () => {
  it('seeds with the promoted mode', async () => {
    const { service, search } = build(V2);

    await service.recall(CONTEXT, { query: 'where does Jordan live', maxResults: 5 });

    expect(search).toHaveBeenCalledWith(CONTEXT, expect.objectContaining({ mode: 'hybrid' }));
  });

  it('forwards the promoted message K and an explicit distance floor', async () => {
    const { service, searchMessages } = build(V2);

    await service.recall(CONTEXT, { query: 'where does Jordan live', maxResults: 5 });

    expect(searchMessages).toHaveBeenCalledWith(CONTEXT, 'where does Jordan live', 15, 0.35);
  });

  it('cuts the anchored channel at the promoted depth and the semantic one at the promoted floor', async () => {
    const { service, search, searchAnchored } = build(V2);

    await service.recall(
      CONTEXT,
      { query: 'What sports do you follow?', maxResults: 5 },
      { strategy: 'grounded' },
    );

    expect(searchAnchored).toHaveBeenCalledWith(
      CONTEXT,
      'What sports do you follow?',
      expect.objectContaining({ maxResults: 15 }),
    );
    expect(search).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({ mode: 'semantic', distanceThreshold: 1 - 0.75 }),
    );
  });
});

describe('RecallService — one policy read per recall', () => {
  it('resolves the policy once, so both channels of a call share a version', async () => {
    const { service, retrievalPolicy } = build(V2);

    await service.recall(
      CONTEXT,
      { query: 'What sports do you follow?', maxResults: 5 },
      { strategy: 'grounded' },
    );

    // grounded runs two seed channels and then the message channel; a
    // promotion landing between them would produce a block no single version
    // explains.
    expect(retrievalPolicy.get).toHaveBeenCalledTimes(1);
  });

  it('does not read the policy at all when the query sanitises to nothing', async () => {
    const { service, retrievalPolicy } = build();

    const result = await service.recall(CONTEXT, { query: '   ', maxResults: 5 });

    expect(result.resultCount).toBe(0);
    expect(retrievalPolicy.get).not.toHaveBeenCalled();
  });
});
