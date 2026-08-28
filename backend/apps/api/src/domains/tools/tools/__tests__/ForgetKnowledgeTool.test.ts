import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import type { GraphNodeEntity, GraphUtilityService, RelationshipEntity } from '@ci/domains/memory';
import {
  ConceptRemovedEvent,
  PersonRemovedEvent,
  PlaceRemovedEvent,
  type ConceptDeletedPayload,
  type PersonDeletedPayload,
  type PlaceDeletedPayload,
} from '@ci/domains/memory/events';

import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;

// entityIds/relationshipIds are `z.array(z.string().uuid())` in ForgetKnowledgeInputSchema, so
// fixtures need real UUIDs or validateInput rejects the whole call before executeInternal runs.
const E1 = '11111111-1111-1111-1111-111111111111';
const E_MISSING = '88888888-8888-8888-8888-888888888888';
const E_MISSING_ONLY = '99999999-9999-9999-9999-999999999999';
const R1 = '22222222-2222-2222-2222-222222222222';
const R_CASCADE = '33333333-3333-3333-3333-333333333333';
const R_EXPLICIT = '44444444-4444-4444-4444-444444444444';
const R_SHARED = '55555555-5555-5555-5555-555555555555';

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
}

function fakeNode(entityId: string, entityType = 'Concept'): GraphNodeEntity {
  return { entity_id: entityId, entity_type: entityType } as GraphNodeEntity;
}

/**
 * Stand-in for `ci_search`, keyed the way the real tables are: (search type,
 * id). Rows are dropped by dispatching on the SAME `*RemovedEvent` constants
 * the real `*SearchIndexListener.unindex*` handlers subscribe to and by the
 * same payload id they read, so a tool that emits a different event, or the
 * right event carrying a different id, leaves the row answering searches here
 * exactly as it would in production.
 */
function makeSearchIndex(seeded: string[] = []) {
  const rows = new Set(seeded);

  const send = jest.fn(async (name: string, payload: Record<string, unknown>) => {
    switch (name) {
      case PersonRemovedEvent:
        rows.delete(`person:${(payload as PersonDeletedPayload).personId}`);
        break;
      case PlaceRemovedEvent:
        rows.delete(`place:${(payload as PlaceDeletedPayload).placeId}`);
        break;
      case ConceptRemovedEvent:
        rows.delete(`concept:${(payload as ConceptDeletedPayload).conceptId}`);
        break;
    }

    return [];
  });

  return {
    send,
    eventService: { send } as unknown as EventService,
    /** What a search would find: the index row for this type/id, or nothing. */
    lookup: (searchType: string, entityId: string) => rows.has(`${searchType}:${entityId}`),
  };
}

function fakeRel(relationshipId: string): RelationshipEntity {
  return { relationship_id: relationshipId } as RelationshipEntity;
}

/** Builds a jest-mock GraphUtilityService double with a controllable node/relationship table. */
function makeGraphUtility(
  options: {
    nodes?: Record<string, { relationships?: RelationshipEntity[]; entityType?: string }>;
    relationshipsById?: Record<string, RelationshipEntity>;
  } = {},
) {
  const nodes = options.nodes ?? {};
  const relationshipsById = options.relationshipsById ?? {};

  const collectEntitySnapshot = jest.fn(async (entityId: string) => {
    const entry = nodes[entityId];
    if (!entry) {
      return { node: null, relationships: [] };
    }

    return {
      node: fakeNode(entityId, entry.entityType),
      relationships: entry.relationships ?? [],
    };
  });

  const getRelationships = jest.fn(async (_ownerId: string, opts: { relationshipIds?: string[] }) =>
    (opts.relationshipIds ?? [])
      .map((id) => relationshipsById[id])
      .filter((r): r is RelationshipEntity => Boolean(r)),
  );

  const deactivateEntities = jest.fn().mockResolvedValue(0);
  const deactivateRelationships = jest.fn().mockResolvedValue(0);

  return { collectEntitySnapshot, getRelationships, deactivateEntities, deactivateRelationships };
}

function makeTool(
  graphUtility: ReturnType<typeof makeGraphUtility>,
  search: ReturnType<typeof makeSearchIndex> = makeSearchIndex(),
) {
  return new ForgetKnowledgeTool(
    graphUtility as unknown as GraphUtilityService,
    search.eventService,
    logger(),
  );
}

describe('ForgetKnowledgeTool', () => {
  it('dedupes repeated entityIds/relationshipIds before touching the graph', async () => {
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { relationships: [] } },
      relationshipsById: { [R1]: fakeRel(R1) },
    });
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1, E1],
      relationshipIds: [R1, R1],
      mode: 'archive',
    });

    expect(result.success).toBe(true);
    expect(graphUtility.collectEntitySnapshot).toHaveBeenCalledTimes(1);
    expect(graphUtility.getRelationships).toHaveBeenCalledWith(
      CONTEXT.userId,
      expect.objectContaining({ relationshipIds: [R1] }),
    );
    expect(result.data?.archivedRelationshipIds).toEqual([R1]);
  });

  it('cascades relationships pulled off an archived entity into the same deactivate call as explicit relationshipIds', async () => {
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { relationships: [fakeRel(R_CASCADE)] } },
      relationshipsById: { [R_EXPLICIT]: fakeRel(R_EXPLICIT) },
    });
    const tool = makeTool(graphUtility);

    await tool.execute(CONTEXT, { entityIds: [E1], relationshipIds: [R_EXPLICIT], mode: 'archive' });

    expect(graphUtility.deactivateRelationships).toHaveBeenCalledTimes(1);
    const [idsArg] = graphUtility.deactivateRelationships.mock.calls[0];
    expect(new Set(idsArg)).toEqual(new Set([R_CASCADE, R_EXPLICIT]));
  });

  it('dedupes a relationship id that is both cascaded from an entity snapshot and passed explicitly', async () => {
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { relationships: [fakeRel(R_SHARED)] } },
      relationshipsById: { [R_SHARED]: fakeRel(R_SHARED) },
    });
    const tool = makeTool(graphUtility);

    await tool.execute(CONTEXT, { entityIds: [E1], relationshipIds: [R_SHARED], mode: 'archive' });

    const [idsArg] = graphUtility.deactivateRelationships.mock.calls[0];
    expect(idsArg).toEqual([R_SHARED]);
  });

  it('aggregates a not-found warning for a missing entity while still archiving the found one', async () => {
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { relationships: [] } } });
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E_MISSING], mode: 'archive' });

    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.warnings).toEqual([`Entity ${E_MISSING} not found or not owned by user`]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, false);
  });

  it('passes hardDelete=false in archive mode and hardDelete=true in archive_and_delete mode', async () => {
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { relationships: [fakeRel(R1)] } },
    });
    const archiveTool = makeTool(graphUtility);
    await archiveTool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });
    expect(graphUtility.deactivateEntities).toHaveBeenLastCalledWith([E1], CONTEXT.userId, false);
    expect(graphUtility.deactivateRelationships).toHaveBeenLastCalledWith([R1], CONTEXT.userId, false);

    const graphUtility2 = makeGraphUtility({ nodes: { [E1]: { relationships: [fakeRel(R1)] } } });
    const deleteTool = makeTool(graphUtility2);
    await deleteTool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });
    expect(graphUtility2.deactivateEntities).toHaveBeenLastCalledWith([E1], CONTEXT.userId, true);
    expect(graphUtility2.deactivateRelationships).toHaveBeenLastCalledWith([R1], CONTEXT.userId, true);
  });

  it('skips the deactivate calls entirely when nothing resolved (no entities found, no relationships)', async () => {
    const graphUtility = makeGraphUtility();
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, { entityIds: [E_MISSING_ONLY], mode: 'archive' });

    expect(result.data?.archivedEntityIds).toEqual([]);
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
  });

  it('fails cleanly via BaseTool error handling when the execution context has no userId', async () => {
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { relationships: [] } } });
    const tool = makeTool(graphUtility);

    const result = await tool.execute({} as RequestContext, { entityIds: [E1], mode: 'archive' });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('User context is required to forget knowledge');
    expect(graphUtility.collectEntitySnapshot).not.toHaveBeenCalled();
  });

  it('rejects input with neither entityIds nor relationshipIds at validation time', async () => {
    const graphUtility = makeGraphUtility();
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, {});

    expect(result.success).toBe(false);
    expect(graphUtility.collectEntitySnapshot).not.toHaveBeenCalled();
  });
});

describe('ForgetKnowledgeTool search index removal', () => {
  it.each([
    ['Concept', 'concept'],
    ['Person', 'person'],
    // Graph spellings the search vocabulary aliases onto the same type.
    ['Contact', 'person'],
    ['Location', 'place'],
  ])('a forgotten %s is no longer findable in the search index', async (entityType, searchType) => {
    const search = makeSearchIndex([`${searchType}:${E1}`]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
    const tool = makeTool(graphUtility, search);

    expect(search.lookup(searchType, E1)).toBe(true);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(result.success).toBe(true);
    expect(search.lookup(searchType, E1)).toBe(false);
  });

  it('removes the index rows in archive_and_delete mode too', async () => {
    const search = makeSearchIndex([`concept:${E1}`]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Concept' } } });
    const tool = makeTool(graphUtility, search);

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(search.lookup('concept', E1)).toBe(false);
  });

  it('leaves an entity that was never found alone', async () => {
    const search = makeSearchIndex([`concept:${E_MISSING_ONLY}`]);
    const graphUtility = makeGraphUtility();
    const tool = makeTool(graphUtility, search);

    await tool.execute(CONTEXT, { entityIds: [E_MISSING_ONLY], mode: 'archive' });

    expect(search.send).not.toHaveBeenCalled();
    expect(search.lookup('concept', E_MISSING_ONLY)).toBe(true);
  });

  it('announces no deletion for a type whose record this tool did not remove', async () => {
    // An `Event` graph node is the `ci.entities` half of a pair whose `ci.events`
    // detail row forget never touches. Emitting `event.deleted` for a record that
    // still exists would be false to every consumer of that event, so the tool
    // must stay quiet rather than unindex a live record.
    const search = makeSearchIndex([`event:${E1}`]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Event' } } });
    const tool = makeTool(graphUtility, search);

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(search.send).not.toHaveBeenCalled();
  });
});
