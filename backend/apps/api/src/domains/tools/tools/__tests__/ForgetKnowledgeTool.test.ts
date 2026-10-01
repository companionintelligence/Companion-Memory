import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import type {
  CalendarEventService,
  ContentService,
  GraphNodeEntity,
  GraphUtilityService,
  RelationshipEntity,
} from '@ci/domains/memory';
import {
  CommunicationRemovedEvent,
  ConceptRemovedEvent,
  ContentRemovedEvent,
  ItemRemovedEvent,
  PersonRemovedEvent,
  PlaceRemovedEvent,
  type CommunicationDeletedPayload,
  type ConceptDeletedPayload,
  type ContentDeletedPayload,
  type ItemDeletedPayload,
  type PersonDeletedPayload,
  type PlaceDeletedPayload,
} from '@ci/domains/memory/events';

import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;

// entityIds/relationshipIds are `z.array(z.string().uuid())` in ForgetKnowledgeInputSchema, so
// fixtures need real UUIDs or validateInput rejects the whole call before executeInternal runs.
const E1 = '11111111-1111-1111-1111-111111111111';
const E2 = '77777777-7777-7777-7777-777777777777';
const E3 = '66666666-6666-6666-6666-666666666666';
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
      case ContentRemovedEvent:
        rows.delete(`content:${(payload as ContentDeletedPayload).contentId}`);
        break;
      case ItemRemovedEvent:
        rows.delete(`item:${(payload as ItemDeletedPayload).itemId}`);
        break;
      case CommunicationRemovedEvent:
        rows.delete(`communication:${(payload as CommunicationDeletedPayload).communicationId}`);
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

  // Edges come back only when asked for, as the real snapshot has it: a double that ignored the
  // option would hide exactly what the tool decides about them.
  const collectEntitySnapshot = jest.fn(
    async (entityId: string, _ownerId?: string, snapshotOptions: { includeRelationships?: boolean } = {}) => {
      const entry = nodes[entityId];
      if (!entry) {
        return { node: null, relationships: [] };
      }

      return {
        node: fakeNode(entityId, entry.entityType),
        relationships: snapshotOptions.includeRelationships ? (entry.relationships ?? []) : [],
      };
    },
  );

  const getRelationships = jest.fn(async (_ownerId: string, opts: { relationshipIds?: string[] }) =>
    (opts.relationshipIds ?? [])
      .map((id) => relationshipsById[id])
      .filter((r): r is RelationshipEntity => Boolean(r)),
  );

  const deactivateEntities = jest.fn().mockResolvedValue(0);
  const deactivateRelationships = jest.fn().mockResolvedValue(0);

  return { collectEntitySnapshot, getRelationships, deactivateEntities, deactivateRelationships };
}

/**
 * Stand-in for `CalendarEventService`. `remove` is true exactly once for each id
 * that has a live `ci.events` row to tombstone, false for anything else: an
 * `Event` node with no detail row, or one already in the trash. `purge` takes
 * every id that has a `ci.events` row at all, live or in the trash, and answers
 * with the ones it took, and with the content that hung off them
 * (`contentOfEvents`) and went too.
 */
function makeCalendarEvents(
  liveEventIds: string[] = [],
  trashedEventIds: string[] = [],
  contentOfEvents: Record<string, string[]> = {},
) {
  const live = new Set(liveEventIds);
  const trashed = new Set(trashedEventIds);
  const remove = jest.fn(async (_context: { userId: string }, id: string) => live.delete(id));
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => {
    const eventIds = ids.filter((id) => live.has(id) || trashed.has(id));

    return { eventIds, contentIds: eventIds.flatMap((id) => contentOfEvents[id] ?? []) };
  });

  return { remove, purge };
}

/**
 * Stand-in for `ContentService`. `purge` takes every id that has a `ci.content` row
 * (`purgeableContentIds`) and answers with the ones it took; a `Content` node with
 * no detail row is not among them, as for the real one.
 */
function makeContents(purgeableContentIds: string[] = []) {
  const purgeable = new Set(purgeableContentIds);
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => ({
    contentIds: ids.filter((id) => purgeable.has(id)),
  }));

  return { purge };
}

function makeTool(
  graphUtility: ReturnType<typeof makeGraphUtility>,
  search: ReturnType<typeof makeSearchIndex> = makeSearchIndex(),
  calendarEvents: ReturnType<typeof makeCalendarEvents> = makeCalendarEvents(),
  contents: ReturnType<typeof makeContents> = makeContents(),
) {
  return new ForgetKnowledgeTool(
    graphUtility as unknown as GraphUtilityService,
    search.eventService,
    calendarEvents as unknown as CalendarEventService,
    contents as unknown as ContentService,
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
    // A delete takes the node's edges itself, in both directions and in the same transaction as the
    // node (`deactivateEntities`), so no edge ids are collected for a second step.
    expect(graphUtility2.deactivateRelationships).not.toHaveBeenCalled();
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

  it.each([
    ['Item', 'item'],
    ['Communication', 'communication'],
    ['Content', 'content'],
  ])(
    'announces no deletion for an archived %s, whose record this tool did not remove',
    async (entityType, searchType) => {
      // These graph nodes are the `ci.entities` half of a pair whose detail row
      // (`ci.objects`, `ci.communications`, `ci.content`) archive never touches.
      // Emitting a deletion for a record that still exists would be false to every
      // consumer of it, so the tool must stay quiet rather than unindex a live record.
      const search = makeSearchIndex([`${searchType}:${E1}`]);
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
      const tool = makeTool(graphUtility, search);

      await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

      expect(search.send).not.toHaveBeenCalled();
      expect(search.lookup(searchType, E1)).toBe(true);
    },
  );

  it.each([
    ['Item', 'item'],
    ['Communication', 'communication'],
    // A `Content` node with no `ci.content` row reaches the generic path; one with a row is purged.
    ['Content', 'content'],
  ])(
    'announces a deleted %s as removed, so its index rows go now and not at the nightly sweep',
    async (entityType, searchType) => {
      // The detail row goes with the node, by cascade, so the record IS gone and saying so is true.
      const search = makeSearchIndex([`${searchType}:${E1}`]);
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
      const tool = makeTool(graphUtility, search);

      expect(search.lookup(searchType, E1)).toBe(true);

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(result.success).toBe(true);
      expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
      expect(search.lookup(searchType, E1)).toBe(false);
    },
  );

  it('announces a deletion only after the delete has gone through', async () => {
    const search = makeSearchIndex([`communication:${E1}`]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });
    graphUtility.deactivateEntities.mockRejectedValueOnce(new Error('boom'));
    const tool = makeTool(graphUtility, search);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    // Refused, so nothing was deleted, so nothing is announced and the index still answers.
    expect(result.success).toBe(false);
    expect(search.send).not.toHaveBeenCalled();
    expect(search.lookup('communication', E1)).toBe(true);
  });
});

describe('ForgetKnowledgeTool, what delete leaves behind', () => {
  const LEFT_BEHIND = /rows that name it only by id were left in place/;

  it.each(['Item', 'Communication'])(
    'says that a deleted %s left rows that name it by id, so the caller does not claim a clean erase',
    async (entityType) => {
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
      const tool = makeTool(graphUtility);

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(result.success).toBe(true);
      expect(result.data?.warnings).toEqual([expect.stringMatching(LEFT_BEHIND)]);
      expect(result.data?.warnings?.[0]).toContain(`${entityType} ${E1}`);
    },
  );

  it.each(['Item', 'Communication'])('says nothing of the kind for an archived %s', async (entityType) => {
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(result.data?.warnings).toBeUndefined();
  });

  it.each(['Concept', 'Person', 'Place', 'Content'])(
    'says nothing of the kind for a deleted %s, which is not one of the two it has not purged',
    async (entityType) => {
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
      const tool = makeTool(graphUtility);

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(result.data?.warnings).toBeUndefined();
    },
  );

  it('says it once for each such node, alongside the warnings it already has', async () => {
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Item' }, [E2]: { entityType: 'Communication' } },
    });
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1, E2, E_MISSING],
      mode: 'archive_and_delete',
    });

    expect(result.data?.warnings).toEqual([
      `Entity ${E_MISSING} not found or not owned by user`,
      expect.stringContaining(`Item ${E1} was deleted`),
      expect.stringContaining(`Communication ${E2} was deleted`),
    ]);
  });

  it('reports an item that is another item’s parent as refused, the one foreign key that stops an item', async () => {
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Item' } } });
    const search = makeSearchIndex([`item:${E1}`]);

    graphUtility.deactivateEntities.mockRejectedValueOnce(
      Object.assign(new Error('boom'), {
        code: '23503',
        constraint: 'objects_parent_object_id_fkey',
        table: 'objects',
      }),
    );

    const result = await makeTool(graphUtility, search).execute(CONTEXT, {
      entityIds: [E1],
      mode: 'archive_and_delete',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'objects_parent_object_id_fkey', table: 'objects' },
    });
    // Nothing was deleted, so nothing is announced, and the item is still findable.
    expect(search.send).not.toHaveBeenCalled();
    expect(search.lookup('item', E1)).toBe(true);
  });
});

describe('ForgetKnowledgeTool events', () => {
  it('archives an event through its own tombstone rather than deactivating the graph node', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event', relationships: [fakeRel(R_CASCADE)] } },
    });
    const search = makeSearchIndex();
    const tool = makeTool(graphUtility, search, calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(result.success).toBe(true);
    expect(calendarEvents.remove).toHaveBeenCalledWith({ userId: CONTEXT.userId }, E1);
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.restorableEventIds).toEqual([E1]);
    // `remove` owns both halves, the un-index and the HBPE nudge; the tool
    // repeats none of it.
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(search.send).not.toHaveBeenCalled();
    // A tombstone cascades nothing, which is what lets `restore` be exact.
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
  });

  it('still deactivates explicitly named relationships alongside a trashed event', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event', relationships: [fakeRel(R_CASCADE)] } },
      relationshipsById: { [R_EXPLICIT]: fakeRel(R_EXPLICIT) },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1],
      relationshipIds: [R_EXPLICIT],
      mode: 'archive',
    });

    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_EXPLICIT], CONTEXT.userId, false);
    expect(result.data?.archivedRelationshipIds).toEqual([R_EXPLICIT]);
  });

  it('deactivates an Event node with no live detail row to tombstone, as before', async () => {
    // Graph ingest can write an `Event` node with no `ci.events` row behind it,
    // and an event deleted before `remove` covered the base row is already in
    // the trash. Either way `remove` has nothing to do and the node itself is
    // what is left to forget.
    const calendarEvents = makeCalendarEvents();
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event', relationships: [fakeRel(R_CASCADE)] } },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(calendarEvents.remove).toHaveBeenCalledWith({ userId: CONTEXT.userId }, E1);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, false);
    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_CASCADE], CONTEXT.userId, false);
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.restorableEventIds).toBeUndefined();
  });

  it('trashes only the events in a mixed batch and deactivates the rest', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Event', relationships: [fakeRel(R1)] },
        [E2]: { entityType: 'Concept', relationships: [fakeRel(R_CASCADE)] },
      },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2], mode: 'archive' });

    expect(calendarEvents.remove).toHaveBeenCalledTimes(1);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E2], CONTEXT.userId, false);
    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_CASCADE], CONTEXT.userId, false);
    expect(result.data?.archivedEntityIds).toEqual([E1, E2]);
    expect(result.data?.restorableEventIds).toEqual([E1]);
  });

  it('never consults the tombstone for any other type', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Concept' } } });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(calendarEvents.remove).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, false);
  });
});

describe('ForgetKnowledgeTool events, archive_and_delete', () => {
  it('purges an event instead of deleting its node, and leaves the trash call alone', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event', relationships: [fakeRel(R1)] } },
    });
    const search = makeSearchIndex();
    const tool = makeTool(graphUtility, search, calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(true);
    expect(calendarEvents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    expect(calendarEvents.remove).not.toHaveBeenCalled();
    // The purge removed the node, its content and every edge, in both directions.
    // The tool adds nothing of its own: deleting the node again would be a no-op
    // at best, and the generic path is the one that cannot cope with an event.
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
    expect(search.send).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    // Nothing to restore: that is what delete means.
    expect(result.data?.restorableEventIds).toBeUndefined();
  });

  it('looks nodes up including inactive ones, so an event already in the trash can be purged', async () => {
    const calendarEvents = makeCalendarEvents([], [E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Event' } } });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(graphUtility.collectEntitySnapshot).toHaveBeenCalledWith(
      E1,
      CONTEXT.userId,
      expect.objectContaining({ includeInactive: true }),
    );
    expect(calendarEvents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
  });

  it('does not look inactive nodes up in archive mode, where they are already forgotten', async () => {
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Concept' } } });
    const tool = makeTool(graphUtility);

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(graphUtility.collectEntitySnapshot).toHaveBeenCalledWith(
      E1,
      CONTEXT.userId,
      expect.objectContaining({ includeInactive: false }),
    );
  });

  it('purges every event in a batch with one call and deletes the other nodes the generic way', async () => {
    const calendarEvents = makeCalendarEvents([E1, E2]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Event', relationships: [fakeRel(R1)] },
        [E2]: { entityType: 'Event' },
        [E3]: { entityType: 'Concept', relationships: [fakeRel(R_CASCADE)] },
      },
    });
    const search = makeSearchIndex();
    const tool = makeTool(graphUtility, search, calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

    expect(calendarEvents.purge).toHaveBeenCalledTimes(1);
    expect(calendarEvents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1, E2]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E3], CONTEXT.userId, true);
    // The generic delete takes its node's edges with it, so there is no second step for them.
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3]);
  });

  it('sends an Event node with no ci.events row down the generic path, where there is nothing to cascade', async () => {
    // Graph ingest writes `Event` nodes with no detail row behind them. `purge`
    // answers with only the events it found, and this one has to be deleted too.
    const calendarEvents = makeCalendarEvents();
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event', relationships: [fakeRel(R1)] } },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(calendarEvents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1]);
  });

  it('never asks the calendar to purge anything when the batch holds no event', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(calendarEvents.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
  });

  it('still removes the relationships it was asked to remove by id', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event' } },
      relationshipsById: { [R_EXPLICIT]: fakeRel(R_EXPLICIT) },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1],
      relationshipIds: [R_EXPLICIT],
      mode: 'archive_and_delete',
    });

    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_EXPLICIT], CONTEXT.userId, true);
    expect(result.data?.archivedRelationshipIds).toEqual([R_EXPLICIT]);
  });
});

describe('ForgetKnowledgeTool content, archive_and_delete', () => {
  it('purges a Content node instead of deleting its node, and announces nothing itself', async () => {
    const contents = makeContents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Content', relationships: [fakeRel(R1)] } },
    });
    const search = makeSearchIndex();
    const tool = makeTool(graphUtility, search, makeCalendarEvents(), contents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(true);
    expect(contents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    // The purge removed the node, its detail row, HBPE's links and every row that names it. The tool
    // adds nothing: the generic path is the one that cannot cope with clustered content, and
    // `ContentService.purge` announces its own removal.
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
    expect(search.send).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.restorableEventIds).toBeUndefined();
    expect(result.data?.warnings).toBeUndefined();
  });

  it('purges every Content node in a batch with one call and deletes the other nodes the generic way', async () => {
    const contents = makeContents([E1, E2]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Content' },
        [E2]: { entityType: 'Content' },
        [E3]: { entityType: 'Concept', relationships: [fakeRel(R_CASCADE)] },
      },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), makeCalendarEvents(), contents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

    expect(contents.purge).toHaveBeenCalledTimes(1);
    expect(contents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1, E2]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E3], CONTEXT.userId, true);
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3]);
  });

  it('sends a Content node with no ci.content row down the generic path, where there is nothing to cascade', async () => {
    // Graph ingest writes `Content` nodes with no detail row behind them. `purge` answers with only the
    // content it found, and this one has to be deleted too. HBPE cannot have clustered a row that is
    // not there, so the delete is not refused, and the generic path announces the removal itself.
    const contents = makeContents();
    const search = makeSearchIndex([`content:${E1}`]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });
    const tool = makeTool(graphUtility, search, makeCalendarEvents(), contents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(contents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
    expect(search.lookup('content', E1)).toBe(false);
    expect(result.data?.archivedEntityIds).toEqual([E1]);
  });

  it('purges events first, and leaves content that went with its event to nobody', async () => {
    // E2 is E1's photo, and is named in the same call. Purging the event took it, so purging it again
    // would find nothing and the generic path would find nothing to delete. It is E3 that is left.
    const calendarEvents = makeCalendarEvents([E1], [], { [E1]: [E2] });
    const contents = makeContents([E2, E3]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Event' },
        [E2]: { entityType: 'Content' },
        [E3]: { entityType: 'Content' },
      },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents, contents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

    expect(calendarEvents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    expect(contents.purge).toHaveBeenCalledTimes(1);
    expect(contents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E3]);
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3]);
  });

  it('does not count content it never named as one of the nodes it deleted', async () => {
    // The event's photo is not in the call. It goes with the event, and is not the caller's to be told of.
    const calendarEvents = makeCalendarEvents([E1], [], { [E1]: [E2] });
    const contents = makeContents();
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Event' } } });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents, contents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(contents.purge).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1]);
  });

  it('never asks the content service to purge anything when the batch holds no content', async () => {
    const contents = makeContents([E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    const tool = makeTool(graphUtility, makeSearchIndex(), makeCalendarEvents(), contents);

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(contents.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
  });

  it('never purges content in archive mode, which only deactivates its node', async () => {
    const contents = makeContents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Content', relationships: [fakeRel(R1)] } },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), makeCalendarEvents(), contents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(contents.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, false);
    expect(result.data?.restorableEventIds).toBeUndefined();
  });

  it('still removes the relationships it was asked to remove by id', async () => {
    const contents = makeContents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Content' } },
      relationshipsById: { [R_EXPLICIT]: fakeRel(R_EXPLICIT) },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), makeCalendarEvents(), contents);

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1],
      relationshipIds: [R_EXPLICIT],
      mode: 'archive_and_delete',
    });

    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_EXPLICIT], CONTEXT.userId, true);
    expect(result.data?.archivedRelationshipIds).toEqual([R_EXPLICIT]);
  });
});

describe('ForgetKnowledgeTool edges', () => {
  it('collects a node’s outgoing edges only to archive it, never to delete it', async () => {
    const archiveGraph = makeGraphUtility({ nodes: { [E1]: {} } });
    await makeTool(archiveGraph).execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(archiveGraph.collectEntitySnapshot).toHaveBeenCalledWith(
      E1,
      CONTEXT.userId,
      expect.objectContaining({ includeRelationships: true }),
    );

    const deleteGraph = makeGraphUtility({ nodes: { [E1]: {} } });
    await makeTool(deleteGraph).execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(deleteGraph.collectEntitySnapshot).toHaveBeenCalledWith(
      E1,
      CONTEXT.userId,
      expect.objectContaining({ includeRelationships: false }),
    );
  });
});

/**
 * What the pg driver, and TypeORM on top of it, hand back. TypeORM's `QueryFailedError` copies the
 * driver's fields onto itself and keeps the original as `driverError`; both shapes are covered
 * because callers read either.
 */
function pgFailure(code: string, fields: { constraint?: string; table?: string } = {}, nested = false) {
  const message = `update or delete on table "${fields.table ?? 'events'}" violates foreign key constraint "${fields.constraint ?? 'l1_event_cluster_event_id_fkey'}"`;

  return nested
    ? Object.assign(new Error(message), { driverError: { code, ...fields } })
    : Object.assign(new Error(message), { code, ...fields });
}

describe('ForgetKnowledgeTool failures', () => {
  const FK = { constraint: 'users_entity_id_fkey', table: 'users' };

  it.each([
    ['on the error', false],
    ['on its driverError', true],
  ])('does not call a foreign-key violation retryable (%s)', async (_where, nested) => {
    const calendarEvents = makeCalendarEvents([E1]);
    calendarEvents.purge.mockRejectedValueOnce(pgFailure('23503', FK, nested));
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Event' } } });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', table: 'users' },
    });
    // Says what is in the way, that trying again will not help, and what to do instead.
    expect(result.error?.message).toContain('constraint "users_entity_id_fkey" on table "users"');
    expect(result.error?.message).toContain('Retrying will not change that');
    expect(result.error?.message).toContain('mode "archive"');
  });

  it.each(['23001', '23505', '23502', '23514'])(
    'treats SQLSTATE %s, the rest of the integrity class, the same way',
    async (code) => {
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Concept' } } });
      graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure(code));
      const tool = makeTool(graphUtility);

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({ code: 'CONSTRAINT_VIOLATION', retryable: false });
    },
  );

  it('reports a violation without a constraint name', async () => {
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    graphUtility.deactivateEntities.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: '23503' }),
    );
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.error).toMatchObject({ code: 'CONSTRAINT_VIOLATION', retryable: false });
    expect(result.error?.message).toContain('another record still references one of the entities');
  });

  it.each([
    ['a deadlock', pgFailure('40P01')],
    ['a serialization failure', pgFailure('40001')],
    ['a lock timeout', pgFailure('55P03')],
    ['a dropped connection', Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' })],
    ['an ordinary error', new Error('boom')],
  ])('still calls %s retryable, as BaseTool does', async (_name, failure) => {
    const calendarEvents = makeCalendarEvents([E1]);
    calendarEvents.purge.mockRejectedValueOnce(failure);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Event' } } });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'EXECUTION_ERROR', retryable: true });
  });

  it('stops where a purge failed: nothing before it was destroyed, and nothing after it is touched', async () => {
    // `purge` is one transaction for the whole batch, so a refusal leaves every event as it was.
    const calendarEvents = makeCalendarEvents([E1, E2]);
    calendarEvents.purge.mockRejectedValueOnce(pgFailure('23503', FK));
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Event' },
        [E2]: { entityType: 'Event' },
        [E3]: { entityType: 'Concept' },
      },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

    expect(result.error).toMatchObject({ code: 'CONSTRAINT_VIOLATION', retryable: false });
    expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
    expect(result.error?.message).not.toContain('Already deleted');
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
  });

  it('names the events already destroyed when it is the rest of the call that is refused', async () => {
    // The purge commits first and cannot be undone, so a later refusal has to say what is gone.
    const calendarEvents = makeCalendarEvents([E1, E2]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event' }, [E2]: { entityType: 'Event' }, [E3]: { entityType: 'Person' } },
    });
    graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure('23503', FK));
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', table: 'users', deletedEntityIds: [E1, E2] },
    });
    expect(result.error?.message).toContain('still references one of the entities.');
    expect(result.error?.message).toContain(`Already deleted: ${E1}, ${E2}.`);
  });

  it('carries that progress on a retryable failure too', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event' }, [E3]: { entityType: 'Concept' } },
    });
    graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure('40P01'));
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E3], mode: 'archive_and_delete' });

    expect(result.error).toMatchObject({
      code: 'EXECUTION_ERROR',
      retryable: true,
      details: { deletedEntityIds: [E1] },
    });
    expect(result.error?.message).toContain(`Already deleted: ${E1}.`);
  });

  it('says nothing of progress when nothing was destroyed before the failure', async () => {
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure('23503'));
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
    expect(result.error?.message).not.toContain('Already deleted');
  });

  it('does not call an event it only moved to the trash deleted, when archiving then fails', async () => {
    // A trashed event comes back with `restore`, so "already deleted" would be false.
    const calendarEvents = makeCalendarEvents([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Event' }, [E3]: { entityType: 'Concept' } },
    });
    graphUtility.deactivateEntities.mockRejectedValueOnce(new Error('boom'));
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E3], mode: 'archive' });

    expect(calendarEvents.remove).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({ code: 'EXECUTION_ERROR', retryable: true, message: 'boom' });
    expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
  });

  describe('with content', () => {
    it('refuses a content purge whole, and says nothing was destroyed, when it is the first thing to be purged', async () => {
      const contents = makeContents([E1, E2]);
      contents.purge.mockRejectedValueOnce(pgFailure('23503', FK));
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Content' },
          [E2]: { entityType: 'Content' },
          [E3]: { entityType: 'Concept' },
        },
      });
      const tool = makeTool(graphUtility, makeSearchIndex(), makeCalendarEvents(), contents);

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({ code: 'CONSTRAINT_VIOLATION', retryable: false });
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(result.error?.message).not.toContain('Already deleted');
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names the events already destroyed when it is the content purge that is refused', async () => {
      // The events committed in their own transaction, and cannot be undone.
      const calendarEvents = makeCalendarEvents([E1]);
      const contents = makeContents([E2]);
      contents.purge.mockRejectedValueOnce(pgFailure('23503', FK));
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Event' },
          [E2]: { entityType: 'Content' },
          [E3]: { entityType: 'Concept' },
        },
      });
      const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents, contents);

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [E1] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}.`);
      // Nothing after the refused purge was touched.
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names the content already destroyed when it is the rest of the call that is refused', async () => {
      const contents = makeContents([E1, E2]);
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Content' },
          [E2]: { entityType: 'Content' },
          [E3]: { entityType: 'Person' },
        },
      });
      graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure('23503', FK));
      const tool = makeTool(graphUtility, makeSearchIndex(), makeCalendarEvents(), contents);

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { deletedEntityIds: [E1, E2] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}, ${E2}.`);
    });

    it('lists the nodes the caller named that are gone, and not a photo that went with an event without being named', async () => {
      // E1 is an event with two photos. The caller named one of them, E2, and a standalone content
      // node, E3. The other photo went with the event but was never in the call, so it is not listed.
      const NAMED_PHOTO = E2;
      const UNNAMED_PHOTO = E_MISSING;
      const calendarEvents = makeCalendarEvents([E1], [], { [E1]: [NAMED_PHOTO, UNNAMED_PHOTO] });
      const contents = makeContents([E3]);
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Event' },
          [NAMED_PHOTO]: { entityType: 'Content' },
          [E3]: { entityType: 'Content' },
          [E_MISSING_ONLY]: { entityType: 'Person' },
        },
      });
      graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure('40P01'));
      const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents, contents);

      const result = await tool.execute(CONTEXT, {
        entityIds: [E1, NAMED_PHOTO, E3, E_MISSING_ONLY],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({
        code: 'EXECUTION_ERROR',
        retryable: true,
        details: { deletedEntityIds: [E1, NAMED_PHOTO, E3] },
      });
    });
  });
});
