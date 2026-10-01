import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  StoredObjectsDeletedError,
  type CalendarEventService,
  type CommunicationService,
  type ConceptService,
  type ContentService,
  type FileService,
  type GraphNodeEntity,
  type GraphUtilityService,
  type ItemService,
  type KeptFile,
  type PersonService,
  type PlaceService,
  type PurgedFiles,
  type RelationshipEntity,
  type WrappedFilesPurged,
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

// A type nothing purges (`Organization`: a Facebook Page the user liked), so a case that does not say
// what its node is exercises the generic path and not one of the per-type purges.
function fakeNode(entityId: string, entityType = 'Organization'): GraphNodeEntity {
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
 * What a purge of content or of an event answers about the stored files it wrapped: nothing, unless a case
 * says otherwise.
 */
function wrapped(extra: Partial<WrappedFilesPurged> = {}): WrappedFilesPurged {
  return {
    wrappedFileIds: [],
    fileIds: [],
    nodeIds: [],
    deletedObjects: 0,
    keptObjects: 0,
    kept: [],
    ...extra,
  };
}

/** A wrapped file that was kept, with nothing using it unless a case says what. */
function keptFile(
  fileId: string,
  extra: { nodeId?: string; usedBy?: Partial<KeptFile['usedBy']> } = {},
): KeptFile {
  return {
    fileId,
    nodeId: extra.nodeId ?? null,
    usedBy: { contentIds: [], messageIds: [], chatMessageIds: [], eventId: null, ...extra.usedBy },
  };
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
  files: WrappedFilesPurged = wrapped(),
) {
  const live = new Set(liveEventIds);
  const trashed = new Set(trashedEventIds);
  const remove = jest.fn(async (_context: { userId: string }, id: string) => live.delete(id));
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => {
    const eventIds = ids.filter((id) => live.has(id) || trashed.has(id));

    return { eventIds, contentIds: eventIds.flatMap((id) => contentOfEvents[id] ?? []), files };
  });

  return { remove, purge };
}

/**
 * Stand-in for `ContentService`. `purge` takes every id that has a `ci.content` row
 * (`purgeableContentIds`) and answers with the ones it took; a `Content` node with
 * no detail row is not among them, as for the real one.
 */
function makeContents(purgeableContentIds: string[] = [], files: WrappedFilesPurged = wrapped()) {
  const purgeable = new Set(purgeableContentIds);
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => ({
    contentIds: ids.filter((id) => purgeable.has(id)),
    files,
  }));

  return { purge };
}

/**
 * Stand-in for `CommunicationService`. `purge` takes every id that has a `ci.communications` row
 * (`purgeableCommunicationIds`) and answers with the ones it took, with the content rows its attachments
 * named that went too (`contentIds`) and with what was done about the stored files (`files`); a
 * `Communication` node with no detail row is not among them, as for the real one.
 */
function makeCommunications(
  purgeableCommunicationIds: string[] = [],
  extra: { contentIds?: string[]; files?: WrappedFilesPurged } = {},
) {
  const purgeable = new Set(purgeableCommunicationIds);
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => ({
    communicationIds: ids.filter((id) => purgeable.has(id)),
    contentIds: extra.contentIds ?? [],
    files: extra.files ?? wrapped(),
  }));

  return { purge };
}

/**
 * Stand-in for `ItemService`. `purge` takes every id that has a `ci.objects` row (`purgeableItemIds`)
 * and answers with the ones it took, and with the duplicates that had been merged into them
 * (`duplicatesOf`) and went too; an `Item` node with no detail row is not among them, as for the real one.
 */
function makeItems(purgeableItemIds: string[] = [], duplicatesOf: Record<string, string[]> = {}) {
  const purgeable = new Set(purgeableItemIds);
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => {
    const itemIds = ids.filter((id) => purgeable.has(id));

    return { itemIds, duplicateIds: itemIds.flatMap((id) => duplicatesOf[id] ?? []) };
  });

  return { purge };
}

/**
 * Stand-in for `FileService`. `purge` takes every id that has a `ci.files` row (`purgeableNodeIds`) and
 * answers with the ones it took, the stored file each stood for, the copies of those files that went with
 * them (`copiesOf`: file ids by the node that was named) and the content that wraps them (`wrappingOf`: ids
 * by node). `keptObjects` is how many stored objects stayed. A `File` node with no detail row is not among
 * them, as for the real one.
 */
function makeFiles(
  purgeableNodeIds: string[] = [],
  extra: {
    copiesOf?: Record<string, string[]>;
    wrappingOf?: Record<string, string[]>;
    keptObjects?: number;
  } = {},
) {
  const purgeable = new Set(purgeableNodeIds);
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]): Promise<PurgedFiles> => {
    const nodeIds = ids.filter((id) => purgeable.has(id));
    const copyFileIds = nodeIds.flatMap((id) => extra.copiesOf?.[id] ?? []);

    return {
      nodeIds,
      fileIds: [...nodeIds.map((id) => `file-of-${id}`), ...copyFileIds],
      copyFileIds,
      deletedObjects: nodeIds.length + copyFileIds.length,
      keptObjects: extra.keptObjects ?? 0,
      wrappingContentIds: nodeIds.flatMap((id) => extra.wrappingOf?.[id] ?? []),
    };
  });

  return { purge };
}

/**
 * Stand-in for `PersonService`. `purge` takes every id in `purgeablePersonIds` and answers with the ones it
 * took, with the duplicates that had been merged into them (`duplicatesOf`) and went too, and with how many of
 * their identifiers it recorded as forgotten (`blockedIdentifiers`). An id it does not know is not among them,
 * as for the real one.
 */
function makePeople(
  purgeablePersonIds: string[] = [],
  duplicatesOf: Record<string, string[]> = {},
  blockedIdentifiers = 0,
) {
  const purgeable = new Set(purgeablePersonIds);
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => {
    const personIds = ids.filter((id) => purgeable.has(id));

    return {
      personIds,
      duplicateIds: personIds.flatMap((id) => duplicatesOf[id] ?? []),
      blockedIdentifiers: personIds.length > 0 ? blockedIdentifiers : 0,
    };
  });

  return { purge };
}

/** Stand-in for `PlaceService`, shaped like {@link makePeople}'s without the identifiers. */
function makePlaces(purgeablePlaceIds: string[] = [], duplicatesOf: Record<string, string[]> = {}) {
  const purgeable = new Set(purgeablePlaceIds);
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => {
    const placeIds = ids.filter((id) => purgeable.has(id));

    return { placeIds, duplicateIds: placeIds.flatMap((id) => duplicatesOf[id] ?? []) };
  });

  return { purge };
}

/** Stand-in for `ConceptService`, shaped like {@link makePlaces}'s. */
function makeConcepts(purgeableConceptIds: string[] = [], duplicatesOf: Record<string, string[]> = {}) {
  const purgeable = new Set(purgeableConceptIds);
  const purge = jest.fn(async (_context: { userId: string }, ids: string[]) => {
    const conceptIds = ids.filter((id) => purgeable.has(id));

    return { conceptIds, duplicateIds: conceptIds.flatMap((id) => duplicatesOf[id] ?? []) };
  });

  return { purge };
}

/** Every collaborator the tool takes besides the graph, by name, so a case overrides only what it is about. */
interface Collaborators {
  search: ReturnType<typeof makeSearchIndex>;
  calendarEvents: ReturnType<typeof makeCalendarEvents>;
  contents: ReturnType<typeof makeContents>;
  communications: ReturnType<typeof makeCommunications>;
  items: ReturnType<typeof makeItems>;
  files: ReturnType<typeof makeFiles>;
  people: ReturnType<typeof makePeople>;
  places: ReturnType<typeof makePlaces>;
  concepts: ReturnType<typeof makeConcepts>;
}

function toolWith(graphUtility: ReturnType<typeof makeGraphUtility>, overrides: Partial<Collaborators> = {}) {
  const collaborators: Collaborators = {
    search: makeSearchIndex(),
    calendarEvents: makeCalendarEvents(),
    contents: makeContents(),
    communications: makeCommunications(),
    items: makeItems(),
    files: makeFiles(),
    people: makePeople(),
    places: makePlaces(),
    concepts: makeConcepts(),
    ...overrides,
  };

  return new ForgetKnowledgeTool(
    graphUtility as unknown as GraphUtilityService,
    collaborators.search.eventService,
    collaborators.calendarEvents as unknown as CalendarEventService,
    collaborators.contents as unknown as ContentService,
    collaborators.communications as unknown as CommunicationService,
    collaborators.items as unknown as ItemService,
    collaborators.files as unknown as FileService,
    collaborators.people as unknown as PersonService,
    collaborators.places as unknown as PlaceService,
    collaborators.concepts as unknown as ConceptService,
    logger(),
  );
}

function makeTool(
  graphUtility: ReturnType<typeof makeGraphUtility>,
  search: ReturnType<typeof makeSearchIndex> = makeSearchIndex(),
  calendarEvents: ReturnType<typeof makeCalendarEvents> = makeCalendarEvents(),
  contents: ReturnType<typeof makeContents> = makeContents(),
  communications: ReturnType<typeof makeCommunications> = makeCommunications(),
  items: ReturnType<typeof makeItems> = makeItems(),
  files: ReturnType<typeof makeFiles> = makeFiles(),
) {
  return toolWith(graphUtility, { search, calendarEvents, contents, communications, items, files });
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
    // A node with no detail row (`ci.content`, `ci.communications`, `ci.objects`) reaches the generic path;
    // one with a row is purged and announced by its own service.
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

describe('ForgetKnowledgeTool, what delete says it left behind', () => {
  // Every node a delete reaches through the generic path used to get a warning if it was an item, because the
  // rows that name an item by id were left in place. Items are purged now, as events, content and
  // communications are, so there is nothing to say, and the warning is gone.
  it.each(['Item', 'Concept', 'Person', 'Place', 'Content', 'Communication'])(
    'says nothing of rows left in place for a deleted %s that takes the generic path',
    async (entityType) => {
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
      const tool = makeTool(graphUtility);

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(result.success).toBe(true);
      expect(result.data?.warnings).toBeUndefined();
    },
  );

  it('keeps the warnings it still has, such as an entity it could not find', async () => {
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Item' } } });
    const tool = makeTool(graphUtility);

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1, E_MISSING],
      mode: 'archive_and_delete',
    });

    expect(result.data?.warnings).toEqual([`Entity ${E_MISSING} not found or not owned by user`]);
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

describe('ForgetKnowledgeTool communications, archive_and_delete', () => {
  it('purges a Communication node instead of deleting its node, and announces nothing itself', async () => {
    const communications = makeCommunications([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Communication', relationships: [fakeRel(R1)] } },
    });
    const search = makeSearchIndex();
    const tool = makeTool(graphUtility, search, makeCalendarEvents(), makeContents(), communications);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(true);
    expect(communications.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    // The purge removed the node, its detail row, the participants' identifier claims and every row that
    // names it, and `CommunicationService.purge` announces its own removal and tells HBPE. The tool adds
    // nothing, and above all does not go on to delete the node the generic way, which would leave the claims.
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
    expect(search.send).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.restorableEventIds).toBeUndefined();
    // It is gone, and nothing it names by id is left behind, so there is nothing to warn of.
    expect(result.data?.warnings).toBeUndefined();
  });

  it('purges every Communication node in a batch with one call and deletes the other nodes the generic way', async () => {
    const communications = makeCommunications([E1, E2]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Communication' },
        [E2]: { entityType: 'Communication' },
        [E3]: { entityType: 'Concept', relationships: [fakeRel(R_CASCADE)] },
      },
    });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      communications,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

    expect(communications.purge).toHaveBeenCalledTimes(1);
    expect(communications.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1, E2]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E3], CONTEXT.userId, true);
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3]);
  });

  it('sends a Communication node with no ci.communications row down the generic path, where there is nothing to cascade', async () => {
    // Graph ingest writes `Communication` nodes with no detail row behind them. `purge` answers with only
    // the communications it found, and this one has to be deleted too. Nothing references a row that is
    // not there, so the delete is not refused, and the generic path announces the removal itself.
    const communications = makeCommunications();
    const search = makeSearchIndex([`communication:${E1}`]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });
    const tool = makeTool(graphUtility, search, makeCalendarEvents(), makeContents(), communications);

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(communications.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
    expect(search.lookup('communication', E1)).toBe(false);
    expect(result.data?.archivedEntityIds).toEqual([E1]);
  });

  it('never asks the communication service to purge anything when the batch holds no communication', async () => {
    const communications = makeCommunications([E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      communications,
    );

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(communications.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
  });

  it('never purges a communication in archive mode, which only deactivates its node', async () => {
    const communications = makeCommunications([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Communication', relationships: [fakeRel(R1)] } },
    });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      communications,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(communications.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, false);
    expect(result.data?.restorableEventIds).toBeUndefined();
  });

  it('purges each kind in its own call, events and content before communications', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const contents = makeContents([E2]);
    const communications = makeCommunications([E3]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Event' },
        [E2]: { entityType: 'Content' },
        [E3]: { entityType: 'Communication' },
      },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents, contents, communications);

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

    expect(calendarEvents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    expect(contents.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E2]);
    expect(communications.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E3]);
    expect(communications.purge.mock.invocationCallOrder[0]).toBeGreaterThan(
      contents.purge.mock.invocationCallOrder[0],
    );
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3]);
  });

  it('still removes the relationships it was asked to remove by id', async () => {
    const communications = makeCommunications([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Communication' } },
      relationshipsById: { [R_EXPLICIT]: fakeRel(R_EXPLICIT) },
    });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      communications,
    );

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1],
      relationshipIds: [R_EXPLICIT],
      mode: 'archive_and_delete',
    });

    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_EXPLICIT], CONTEXT.userId, true);
    expect(result.data?.archivedRelationshipIds).toEqual([R_EXPLICIT]);
  });
});

describe('ForgetKnowledgeTool items, archive_and_delete', () => {
  it('purges an Item node instead of deleting its node, and announces nothing itself', async () => {
    const items = makeItems([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Item', relationships: [fakeRel(R1)] } },
    });
    const search = makeSearchIndex();
    const tool = makeTool(
      graphUtility,
      search,
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(true);
    expect(items.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    // The purge removed the node, its detail row, its identifiers and merge history, and every row that
    // names it, and `ItemService.purge` announces its own removal. The tool adds nothing, and above all
    // does not go on to delete the node the generic way.
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
    expect(search.send).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.restorableEventIds).toBeUndefined();
    expect(result.data?.warnings).toBeUndefined();
  });

  it('purges every Item node in a batch with one call and deletes the other nodes the generic way', async () => {
    const items = makeItems([E1, E2]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Item' },
        [E2]: { entityType: 'Item' },
        [E3]: { entityType: 'Concept', relationships: [fakeRel(R_CASCADE)] },
      },
    });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

    expect(items.purge).toHaveBeenCalledTimes(1);
    expect(items.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1, E2]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E3], CONTEXT.userId, true);
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3]);
  });

  it('says what went with an item that nobody named: the duplicates that had been merged into it', async () => {
    // E1 is a merge survivor, and the two items hidden behind it as tombstones went in the same transaction.
    const items = makeItems([E1], { [E1]: [E2, E3] });
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Item' } } });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(true);
    // Only the item that was named is one of the nodes the call deleted. The tombstones are not nodes it was
    // asked about, so they are a warning and not a result.
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.warnings).toEqual([
      `Also deleted, because each had been merged into an item named here: ${E2}, ${E3}.`,
    ]);
  });

  it('says nothing of duplicates when none went', async () => {
    const items = makeItems([E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Item' } } });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.data?.warnings).toBeUndefined();
  });

  it('sends an Item node with no ci.objects row down the generic path, where there is nothing to cascade', async () => {
    // Graph ingest writes `Item` nodes with no detail row behind them. `purge` answers with only the items it
    // found, and this one has to be deleted too. Nothing references a row that is not there, so the delete is
    // not refused, and the generic path announces the removal itself.
    const items = makeItems();
    const search = makeSearchIndex([`item:${E1}`]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Item' } } });
    const tool = makeTool(
      graphUtility,
      search,
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(items.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
    expect(search.lookup('item', E1)).toBe(false);
    expect(result.data?.archivedEntityIds).toEqual([E1]);
  });

  it('never asks the item service to purge anything when the batch holds no item', async () => {
    const items = makeItems([E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(items.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
  });

  it('never purges an item in archive mode, which only deactivates its node', async () => {
    const items = makeItems([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Item', relationships: [fakeRel(R1)] } },
    });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

    expect(items.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, false);
    expect(result.data?.restorableEventIds).toBeUndefined();
  });

  it('purges items after events, content and communications, each in its own call', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const contents = makeContents([E2]);
    const communications = makeCommunications([E3]);
    const items = makeItems([E_MISSING]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Event' },
        [E2]: { entityType: 'Content' },
        [E3]: { entityType: 'Communication' },
        [E_MISSING]: { entityType: 'Item' },
      },
    });
    const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents, contents, communications, items);

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1, E2, E3, E_MISSING],
      mode: 'archive_and_delete',
    });

    expect(items.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E_MISSING]);
    expect(items.purge.mock.invocationCallOrder[0]).toBeGreaterThan(
      communications.purge.mock.invocationCallOrder[0],
    );
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3, E_MISSING]);
  });

  it('still removes the relationships it was asked to remove by id', async () => {
    const items = makeItems([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Item' } },
      relationshipsById: { [R_EXPLICIT]: fakeRel(R_EXPLICIT) },
    });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1],
      relationshipIds: [R_EXPLICIT],
      mode: 'archive_and_delete',
    });

    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_EXPLICIT], CONTEXT.userId, true);
    expect(result.data?.archivedRelationshipIds).toEqual([R_EXPLICIT]);
  });

  it('reports an item that is another item’s parent as refused, and says that retrying will not help', async () => {
    // The user's decision: the purge refuses a parent whose child would be left behind, as the database does.
    const items = makeItems([E1]);

    items.purge.mockRejectedValueOnce(
      pgFailure('23503', { constraint: 'objects_parent_object_id_fkey', table: 'objects' }),
    );

    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Item' } } });
    const search = makeSearchIndex([`item:${E1}`]);
    const tool = makeTool(
      graphUtility,
      search,
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      items,
    );

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'objects_parent_object_id_fkey', table: 'objects' },
    });
    expect(result.error?.message).toContain('Retrying will not change that');
    // Nothing was deleted, so nothing is announced, and the item is still findable.
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(search.send).not.toHaveBeenCalled();
    expect(search.lookup('item', E1)).toBe(true);
  });
});

describe('ForgetKnowledgeTool files, archive_and_delete', () => {
  /** A tool whose only interesting collaborators are the graph and the file service. */
  function fileTool(
    graphUtility: ReturnType<typeof makeGraphUtility>,
    files: ReturnType<typeof makeFiles>,
    others: {
      search?: ReturnType<typeof makeSearchIndex>;
      items?: ReturnType<typeof makeItems>;
    } = {},
  ) {
    return makeTool(
      graphUtility,
      others.search ?? makeSearchIndex(),
      makeCalendarEvents(),
      makeContents(),
      makeCommunications(),
      others.items ?? makeItems(),
      files,
    );
  }

  it('purges a File node instead of deleting its node, and announces nothing itself', async () => {
    const files = makeFiles([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'File', relationships: [fakeRel(R1)] } },
    });
    const search = makeSearchIndex();

    const result = await fileTool(graphUtility, files, { search }).execute(CONTEXT, {
      entityIds: [E1],
      mode: 'archive_and_delete',
    });

    expect(result.success).toBe(true);
    expect(files.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    // The purge removed the node, the stored file, its variants and the objects, and `FileService.purge`
    // announces `file.deleted` itself, keyed by the id of the `ci.files` row, which is not the node's. The
    // tool adds nothing, and above all does not go on to delete the node the generic way.
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
    expect(search.send).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.restorableEventIds).toBeUndefined();
    expect(result.data?.warnings).toBeUndefined();
  });

  it('purges every File node in a batch with one call and deletes the other nodes the generic way', async () => {
    const files = makeFiles([E1, E2]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'File' },
        [E2]: { entityType: 'File' },
        [E3]: { entityType: 'Concept', relationships: [fakeRel(R_CASCADE)] },
      },
    });

    const result = await fileTool(graphUtility, files).execute(CONTEXT, {
      entityIds: [E1, E2, E3],
      mode: 'archive_and_delete',
    });

    expect(files.purge).toHaveBeenCalledTimes(1);
    expect(files.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1, E2]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E3], CONTEXT.userId, true);
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3]);
  });

  it('says what went with a file that nobody named: its copies', async () => {
    // E1's preview and playback rows went in the same transaction, with their objects.
    const files = makeFiles([E1], { copiesOf: { [E1]: ['copy-a', 'copy-b'] } });
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'File' } } });

    const result = await fileTool(graphUtility, files).execute(CONTEXT, {
      entityIds: [E1],
      mode: 'archive_and_delete',
    });

    // Only the node that was named is one the call deleted. The copies were not asked about, so they are a
    // warning and not a result.
    expect(result.data?.archivedEntityIds).toEqual([E1]);
    expect(result.data?.warnings).toEqual([
      'Also deleted, because each was a copy (a preview, thumbnail or playback version) of a file named here: copy-a, copy-b.',
    ]);
  });

  it('says when a stored object stayed because another file record still names it', async () => {
    const files = makeFiles([E1], { keptObjects: 2 });
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'File' } } });

    const result = await fileTool(graphUtility, files).execute(CONTEXT, {
      entityIds: [E1],
      mode: 'archive_and_delete',
    });

    expect(result.data?.warnings).toEqual([
      '2 stored object(s) were not deleted because another file record still names them.',
    ]);
  });

  it('lists the content that wraps a deleted file, which stays, so that it can be forgotten on its own', async () => {
    // The user's decision: a photo is a file and a content record wrapping it, and the record is a record in its
    // own right. It is left, and the caller is told, rather than purged without being asked.
    const files = makeFiles([E1], { wrappingOf: { [E1]: [E2, E3] } });
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'File' } } });

    const result = await fileTool(graphUtility, files).execute(CONTEXT, {
      entityIds: [E1],
      mode: 'archive_and_delete',
    });

    expect(result.success).toBe(true);
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(result.data?.warnings).toEqual([
      `Not deleted: content that wraps a deleted file, and still shows its filename and description: ${E2}, ${E3}. Forget it separately to remove it.`,
    ]);
  });

  it('says nothing of copies, objects or content when none were involved', async () => {
    const files = makeFiles([E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'File' } } });

    const result = await fileTool(graphUtility, files).execute(CONTEXT, {
      entityIds: [E1],
      mode: 'archive_and_delete',
    });

    expect(result.data?.warnings).toBeUndefined();
  });

  it('sends a File node with no ci.files row down the generic path, where there is nothing to cascade', async () => {
    // Graph ingest can write `File` nodes with no stored file behind them. `purge` answers with only the nodes it
    // found, and this one has to be deleted too. Nothing references a row that is not there.
    const files = makeFiles();
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'File' } } });

    const result = await fileTool(graphUtility, files).execute(CONTEXT, {
      entityIds: [E1],
      mode: 'archive_and_delete',
    });

    expect(files.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
    expect(result.data?.archivedEntityIds).toEqual([E1]);
  });

  it('never asks the file service to purge anything when the batch holds no File node', async () => {
    const files = makeFiles([E1]);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });

    await fileTool(graphUtility, files).execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(files.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
  });

  it('never purges a file in archive mode, which only deactivates its node', async () => {
    const files = makeFiles([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'File', relationships: [fakeRel(R1)] } },
    });

    const result = await fileTool(graphUtility, files).execute(CONTEXT, {
      entityIds: [E1],
      mode: 'archive',
    });

    expect(files.purge).not.toHaveBeenCalled();
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, false);
    expect(result.data?.restorableEventIds).toBeUndefined();
  });

  it('purges files after events, content, communications and items, each in its own call', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const contents = makeContents([E2]);
    const communications = makeCommunications([E3]);
    const items = makeItems([E_MISSING]);
    const files = makeFiles([E_MISSING_ONLY]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Event' },
        [E2]: { entityType: 'Content' },
        [E3]: { entityType: 'Communication' },
        [E_MISSING]: { entityType: 'Item' },
        [E_MISSING_ONLY]: { entityType: 'File' },
      },
    });
    const tool = makeTool(
      graphUtility,
      makeSearchIndex(),
      calendarEvents,
      contents,
      communications,
      items,
      files,
    );

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1, E2, E3, E_MISSING, E_MISSING_ONLY],
      mode: 'archive_and_delete',
    });

    expect(files.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E_MISSING_ONLY]);
    expect(files.purge.mock.invocationCallOrder[0]).toBeGreaterThan(items.purge.mock.invocationCallOrder[0]);
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3, E_MISSING, E_MISSING_ONLY]);
  });

  it('still removes the relationships it was asked to remove by id', async () => {
    const files = makeFiles([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'File' } },
      relationshipsById: { [R_EXPLICIT]: fakeRel(R_EXPLICIT) },
    });

    const result = await fileTool(graphUtility, files).execute(CONTEXT, {
      entityIds: [E1],
      relationshipIds: [R_EXPLICIT],
      mode: 'archive_and_delete',
    });

    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_EXPLICIT], CONTEXT.userId, true);
    expect(result.data?.archivedRelationshipIds).toEqual([R_EXPLICIT]);
  });

  describe('when the purge fails', () => {
    it('reports an object store that failed as retryable, and says that nothing was deleted', async () => {
      const files = makeFiles([E1]);

      files.purge.mockRejectedValueOnce(
        new Error(
          'The stored objects could not be deleted, so nothing was deleted from the database (some may already be gone, and forgetting again is safe): connect ECONNREFUSED',
        ),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'File' } } });

      const result = await fileTool(graphUtility, files).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ code: 'EXECUTION_ERROR', retryable: true });
      expect(result.error?.message).toContain('nothing was deleted from the database');
      // Nothing was destroyed and nothing is half gone, so the error names neither.
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(result.error?.details).not.toHaveProperty('storedObjectsDeletedFor');
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names the files whose stored contents are gone, and says that forgetting them again finishes the job', async () => {
      const files = makeFiles([E1]);

      files.purge.mockRejectedValueOnce(new StoredObjectsDeletedError([E1], new Error('deadlock detected')));

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'File' } } });

      const result = await fileTool(graphUtility, files).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.success).toBe(false);
      // A deadlock is the kind of failure a second try gets past, and the cause is what decides that.
      expect(result.error).toMatchObject({
        code: 'EXECUTION_ERROR',
        retryable: true,
        details: { storedObjectsDeletedFor: [E1] },
      });
      expect(result.error?.message).toContain('deadlock detected');
      expect(result.error?.message).toContain(`Forgetting them again finishes the job: ${E1}.`);
      // Nothing was destroyed: the entity is still there, only its contents are not.
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(result.error?.message).not.toContain('Already deleted');
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('does not call a foreign-key violation retryable, and still names the files whose contents are gone', async () => {
      // A migration added a table that references `ci.files` with no `ON DELETE` action: the row delete is
      // refused, the same way each time, after the objects had already gone.
      const files = makeFiles([E1]);

      files.purge.mockRejectedValueOnce(
        new StoredObjectsDeletedError(
          [E1],
          pgFailure('23503', { constraint: 'new_table_file_id_fkey', table: 'files' }),
        ),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'File' } } });

      const result = await fileTool(graphUtility, files).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: {
          constraint: 'new_table_file_id_fkey',
          table: 'files',
          storedObjectsDeletedFor: [E1],
        },
      });
      expect(result.error?.message).toContain('Retrying will not change that');
      expect(result.error?.message).toContain(
        `Retrying cannot finish the job until what references them is removed: ${E1}.`,
      );
      expect(result.error?.message).not.toContain('Forgetting them again finishes the job');
    });

    it('lists what an earlier purge destroyed together with the files whose contents are gone', async () => {
      const items = makeItems([E1]);
      const files = makeFiles([E2]);

      files.purge.mockRejectedValueOnce(new StoredObjectsDeletedError([E2], new Error('connection reset')));

      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Item' }, [E2]: { entityType: 'File' } },
      });

      const result = await fileTool(graphUtility, files, { items }).execute(CONTEXT, {
        entityIds: [E1, E2],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({
        code: 'EXECUTION_ERROR',
        details: { deletedEntityIds: [E1], storedObjectsDeletedFor: [E2] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}.`);
      expect(result.error?.message).toContain(`Forgetting them again finishes the job: ${E2}.`);
    });

    it('lists what an earlier purge destroyed when the file purge fails before touching anything', async () => {
      const items = makeItems([E1]);
      const files = makeFiles([E2]);

      files.purge.mockRejectedValueOnce(new Error('The object store did not answer within 60 s'));

      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Item' }, [E2]: { entityType: 'File' } },
      });

      const result = await fileTool(graphUtility, files, { items }).execute(CONTEXT, {
        entityIds: [E1, E2],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({ code: 'EXECUTION_ERROR', details: { deletedEntityIds: [E1] } });
      expect(result.error?.details).not.toHaveProperty('storedObjectsDeletedFor');
      expect(result.error?.message).toContain(`Already deleted: ${E1}.`);
    });
  });
});

describe('ForgetKnowledgeTool people, places and concepts, archive_and_delete', () => {
  // Every spelling `ci.entities` holds each kind under, and the purge each is sent to.
  const SPELLINGS: Array<[entityType: string, kind: 'people' | 'places' | 'concepts']> = [
    ['Person', 'people'],
    ['Contact', 'people'],
    ['Location', 'places'],
    ['Place', 'places'],
    ['Concept', 'concepts'],
  ];

  it.each(SPELLINGS)(
    'purges a %s node through its own service instead of deleting its node, and announces nothing itself',
    async (entityType, kind) => {
      const collaborators = {
        people: makePeople([E1]),
        places: makePlaces([E1]),
        concepts: makeConcepts([E1]),
      };
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType, relationships: [fakeRel(R1)] } },
      });
      const search = makeSearchIndex();
      const tool = toolWith(graphUtility, { search, ...collaborators });

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(result.success).toBe(true);
      expect(collaborators[kind].purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1]);

      // Only the one service for its kind was asked.
      for (const other of Object.keys(collaborators) as Array<keyof typeof collaborators>) {
        if (other !== kind) {
          expect(collaborators[other].purge).not.toHaveBeenCalled();
        }
      }

      // The purge removed the node and every row that names it, and the service announces its own removal.
      // The tool adds nothing, and above all does not go on to delete the node the generic way.
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
      expect(graphUtility.deactivateRelationships).not.toHaveBeenCalled();
      expect(search.send).not.toHaveBeenCalled();
      expect(result.data?.archivedEntityIds).toEqual([E1]);
      expect(result.data?.restorableEventIds).toBeUndefined();
      expect(result.data?.warnings).toBeUndefined();
    },
  );

  it('purges every person, place and concept of a batch with one call each, and deletes the other nodes the generic way', async () => {
    const people = makePeople([E1, E2]);
    const places = makePlaces([E3]);
    const concepts = makeConcepts([E_MISSING]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Person' },
        [E2]: { entityType: 'Contact' },
        [E3]: { entityType: 'Location' },
        [E_MISSING]: { entityType: 'Concept' },
        [E_MISSING_ONLY]: { entityType: 'Organization', relationships: [fakeRel(R_CASCADE)] },
      },
    });
    const tool = toolWith(graphUtility, { people, places, concepts });

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1, E2, E3, E_MISSING, E_MISSING_ONLY],
      mode: 'archive_and_delete',
    });

    expect(people.purge).toHaveBeenCalledTimes(1);
    expect(people.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E1, E2]);
    expect(places.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E3]);
    expect(concepts.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E_MISSING]);
    expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E_MISSING_ONLY], CONTEXT.userId, true);
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3, E_MISSING, E_MISSING_ONLY]);
  });

  it('says what it kept of a person that was forgotten: the identifiers, as digests, and not the messages', async () => {
    const people = makePeople([E1], {}, 3);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    const tool = toolWith(graphUtility, { people });

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(true);
    expect(result.data?.warnings).toEqual([
      '3 email address(es), phone number(s) and handle(s) they used are remembered as digests, so messages that still name them do not create them again. Their messages and events were not deleted.',
    ]);
  });

  it('says nothing of identifiers when a person had none to remember', async () => {
    const people = makePeople([E1], {}, 0);
    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    const tool = toolWith(graphUtility, { people });

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.data?.warnings).toBeUndefined();
  });

  it.each([
    ['Person', 'person', 'people'],
    ['Location', 'place', 'places'],
    ['Concept', 'concept', 'concepts'],
  ] as const)(
    'says what went with a %s that nobody named: the duplicates that had been merged into it',
    async (entityType, noun, kind) => {
      // E1 is a merge survivor, and the two nodes hidden behind it as tombstones went in the same transaction.
      const collaborators = {
        people: makePeople(kind === 'people' ? [E1] : [], { [E1]: [E2, E3] }),
        places: makePlaces(kind === 'places' ? [E1] : [], { [E1]: [E2, E3] }),
        concepts: makeConcepts(kind === 'concepts' ? [E1] : [], { [E1]: [E2, E3] }),
      };
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
      const tool = toolWith(graphUtility, collaborators);

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(result.success).toBe(true);
      // Only the node that was named is one of the nodes the call deleted. The tombstones are not nodes it
      // was asked about, so they are a warning and not a result.
      expect(result.data?.archivedEntityIds).toEqual([E1]);
      expect(result.data?.warnings).toEqual([
        `Also deleted, because each had been merged into a ${noun} named here: ${E2}, ${E3}.`,
      ]);
    },
  );

  it.each([
    ['Person', 'person'],
    ['Location', 'place'],
    ['Concept', 'concept'],
  ])(
    'sends a %s node the purge did not take down the generic path, which announces its removal',
    async (entityType, searchType) => {
      // The default doubles take nothing, as the real services take nothing they do not own.
      const search = makeSearchIndex([`${searchType}:${E1}`]);
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
      const tool = toolWith(graphUtility, { search });

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, true);
      expect(search.lookup(searchType, E1)).toBe(false);
      expect(result.data?.archivedEntityIds).toEqual([E1]);
    },
  );

  it.each([['Organization'], ['Event'], ['Item'], ['Product'], ['File']])(
    'asks none of the three services to purge a %s',
    async (entityType) => {
      const people = makePeople([E1]);
      const places = makePlaces([E1]);
      const concepts = makeConcepts([E1]);
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType } } });
      const tool = toolWith(graphUtility, { people, places, concepts });

      await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

      expect(people.purge).not.toHaveBeenCalled();
      expect(places.purge).not.toHaveBeenCalled();
      expect(concepts.purge).not.toHaveBeenCalled();
    },
  );

  it.each(SPELLINGS)(
    'never purges a %s in archive mode, which only deactivates its node',
    async (entityType) => {
      const people = makePeople([E1]);
      const places = makePlaces([E1]);
      const concepts = makeConcepts([E1]);
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType, relationships: [fakeRel(R1)] } },
      });
      const tool = toolWith(graphUtility, { people, places, concepts });

      const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive' });

      expect(people.purge).not.toHaveBeenCalled();
      expect(places.purge).not.toHaveBeenCalled();
      expect(concepts.purge).not.toHaveBeenCalled();
      expect(graphUtility.deactivateEntities).toHaveBeenCalledWith([E1], CONTEXT.userId, false);
      expect(result.data?.restorableEventIds).toBeUndefined();
    },
  );

  it('purges people, places and concepts after events, content and communications, and before items, each in its own call', async () => {
    const calendarEvents = makeCalendarEvents([E1]);
    const contents = makeContents([E2]);
    const communications = makeCommunications([E3]);
    const people = makePeople([E_MISSING]);
    const places = makePlaces([E_MISSING_ONLY]);
    const concepts = makeConcepts([R1]);
    const items = makeItems([R_CASCADE]);
    const graphUtility = makeGraphUtility({
      nodes: {
        [E1]: { entityType: 'Event' },
        [E2]: { entityType: 'Content' },
        [E3]: { entityType: 'Communication' },
        [E_MISSING]: { entityType: 'Person' },
        [E_MISSING_ONLY]: { entityType: 'Location' },
        [R1]: { entityType: 'Concept' },
        [R_CASCADE]: { entityType: 'Item' },
      },
    });
    const tool = toolWith(graphUtility, {
      calendarEvents,
      contents,
      communications,
      people,
      places,
      concepts,
      items,
    });

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1, E2, E3, E_MISSING, E_MISSING_ONLY, R1, R_CASCADE],
      mode: 'archive_and_delete',
    });

    const order = [calendarEvents, contents, communications, people, places, concepts, items].map(
      (service) => service.purge.mock.invocationCallOrder[0],
    );

    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(result.data?.archivedEntityIds).toEqual([E1, E2, E3, E_MISSING, E_MISSING_ONLY, R1, R_CASCADE]);
  });

  it('still removes the relationships it was asked to remove by id', async () => {
    const people = makePeople([E1]);
    const graphUtility = makeGraphUtility({
      nodes: { [E1]: { entityType: 'Person' } },
      relationshipsById: { [R_EXPLICIT]: fakeRel(R_EXPLICIT) },
    });
    const tool = toolWith(graphUtility, { people });

    const result = await tool.execute(CONTEXT, {
      entityIds: [E1],
      relationshipIds: [R_EXPLICIT],
      mode: 'archive_and_delete',
    });

    expect(graphUtility.deactivateRelationships).toHaveBeenCalledWith([R_EXPLICIT], CONTEXT.userId, true);
    expect(result.data?.archivedRelationshipIds).toEqual([R_EXPLICIT]);
  });

  it('reports the user’s own person as refused, and says that retrying will not help', async () => {
    // `ci.users.entity_id` has no ON DELETE action, so the database refuses the delete and the purge, which is
    // one transaction, rolls back whole: the person, its identifiers, and the digests it would have kept.
    const people = makePeople([E1], {}, 2);

    people.purge.mockRejectedValueOnce(
      pgFailure('23503', { constraint: 'users_entity_id_fkey', table: 'users' }),
    );

    const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Person' } } });
    const search = makeSearchIndex([`person:${E1}`]);
    const tool = toolWith(graphUtility, { search, people });

    const result = await tool.execute(CONTEXT, { entityIds: [E1], mode: 'archive_and_delete' });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', table: 'users' },
    });
    expect(result.error?.message).toContain('Retrying will not change that');
    expect(result.error?.message).toContain('mode "archive"');
    // Nothing was deleted, so nothing is announced, and the person is still findable.
    expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    expect(search.send).not.toHaveBeenCalled();
    expect(search.lookup('person', E1)).toBe(true);
  });
});

describe('ForgetKnowledgeTool wrapped files, archive_and_delete', () => {
  const FILE = 'aaaaaaaa-0000-0000-0000-000000000001';
  const FILE_2 = 'aaaaaaaa-0000-0000-0000-000000000002';
  const COPY = 'aaaaaaaa-0000-0000-0000-0000000000c1';
  const NODE = 'bbbbbbbb-0000-0000-0000-000000000001';
  const MESSAGE = 'cccccccc-0000-0000-0000-000000000001';
  const MESSAGE_2 = 'cccccccc-0000-0000-0000-000000000002';

  /** A tool whose only interesting collaborators are the graph, the content service and the calendar. */
  function wrapTool(
    graphUtility: ReturnType<typeof makeGraphUtility>,
    parts: {
      calendarEvents?: ReturnType<typeof makeCalendarEvents>;
      contents?: ReturnType<typeof makeContents>;
      files?: ReturnType<typeof makeFiles>;
    },
  ) {
    return makeTool(
      graphUtility,
      makeSearchIndex(),
      parts.calendarEvents ?? makeCalendarEvents(),
      parts.contents ?? makeContents(),
      makeCommunications(),
      makeItems(),
      parts.files ?? makeFiles(),
    );
  }

  describe('what it says went', () => {
    it('says which stored files went with content, and that nothing else used them', async () => {
      const contents = makeContents(
        [E1],
        wrapped({ wrappedFileIds: [FILE], fileIds: [FILE], nodeIds: [NODE] }),
      );
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([E1]);
      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the content or event that held them, because nothing else used them: stored file(s) ${FILE}.`,
      ]);
    });

    it('says the same of the files of an event, and counts the copies that went with them', async () => {
      const calendarEvents = makeCalendarEvents(
        [E1],
        [],
        {},
        wrapped({ wrappedFileIds: [FILE, FILE_2], fileIds: [FILE, FILE_2, COPY], nodeIds: [] }),
      );
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Event' } } });

      const result = await wrapTool(graphUtility, { calendarEvents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the content or event that held them, because nothing else used them: stored file(s) ${FILE}, ${FILE_2}, and 1 copy(ies) of them (previews, thumbnails, playback versions).`,
      ]);
    });

    it('lists the first few of a long run of deleted files and counts the rest, so that an album is one line', async () => {
      const ids = Array.from({ length: 8 }, (_, index) => `aaaaaaaa-0000-0000-0000-00000000020${index}`);
      const contents = makeContents([E1], wrapped({ wrappedFileIds: ids, fileIds: ids }));
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the content or event that held them, because nothing else used them: stored file(s) ${ids.slice(0, 5).join(', ')} and 3 more.`,
      ]);
    });

    it('says when a stored object stayed because another file record still names it', async () => {
      const contents = makeContents(
        [E1],
        wrapped({ wrappedFileIds: [FILE], fileIds: [FILE], keptObjects: 2 }),
      );
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.data?.warnings).toContain(
        '2 stored object(s) were not deleted because another file record still names them.',
      );
    });

    it('says nothing of files when the content wrapped none', async () => {
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents: makeContents([E1]) }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.data?.warnings).toBeUndefined();
    });
  });

  describe('what it says stayed, and why', () => {
    it('names a kept file, what still uses it, and the File node to forget to delete it anyway', async () => {
      const contents = makeContents(
        [E1],
        wrapped({
          kept: [
            keptFile(FILE, {
              nodeId: NODE,
              usedBy: {
                messageIds: [MESSAGE, MESSAGE_2],
                contentIds: [E2],
                chatMessageIds: ['m1', 'm2'],
                eventId: E3,
              },
            }),
          ],
        }),
      );
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      // The content went and the call succeeded: a kept file is not a failure, it is what the user is told.
      expect(result.success).toBe(true);
      expect(result.data?.warnings).toEqual([
        `Not deleted: stored file ${FILE} is still used by message(s) ${MESSAGE}, ${MESSAGE_2}; other content ${E2}; 2 chat message(s) that attach it; event ${E3}. Forget its File node ${NODE} to delete it anyway.`,
      ]);
    });

    it('does not offer a File node that does not exist', async () => {
      const contents = makeContents(
        [E1],
        wrapped({ kept: [keptFile(FILE, { usedBy: { messageIds: [MESSAGE] } })] }),
      );
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.data?.warnings).toEqual([
        `Not deleted: stored file ${FILE} is still used by message(s) ${MESSAGE}.`,
      ]);
    });

    it('names only the first few of a long list of users, so that one file is one line', async () => {
      const messages = Array.from({ length: 7 }, (_, index) => `cccccccc-0000-0000-0000-00000000010${index}`);
      const contents = makeContents(
        [E1],
        wrapped({ kept: [keptFile(FILE, { usedBy: { messageIds: messages } })] }),
      );
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.data?.warnings).toEqual([
        `Not deleted: stored file ${FILE} is still used by message(s) ${messages.slice(0, 5).join(', ')} and 2 more.`,
      ]);
    });

    it('lists the first ten kept files and counts the rest', async () => {
      const kept = Array.from({ length: 12 }, (_, index) =>
        keptFile(`aaaaaaaa-0000-0000-0000-0000000001${String(index).padStart(2, '0')}`, {
          usedBy: { messageIds: [MESSAGE] },
        }),
      );
      const calendarEvents = makeCalendarEvents([E1], [], {}, wrapped({ kept }));
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Event' } } });

      const result = await wrapTool(graphUtility, { calendarEvents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      const warnings = result.data?.warnings ?? [];

      expect(warnings).toHaveLength(11);
      expect(warnings.slice(0, 10).every((line) => line.startsWith('Not deleted: stored file '))).toBe(true);
      expect(warnings[10]).toBe(
        '2 more stored file(s) were not deleted either, because something else still uses them.',
      );
    });

    it('says what went and what stayed in the same call', async () => {
      const contents = makeContents(
        [E1],
        wrapped({
          wrappedFileIds: [FILE],
          fileIds: [FILE],
          kept: [keptFile(FILE_2, { nodeId: NODE, usedBy: { messageIds: [MESSAGE] } })],
        }),
      );
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the content or event that held them, because nothing else used them: stored file(s) ${FILE}.`,
        `Not deleted: stored file ${FILE_2} is still used by message(s) ${MESSAGE}. Forget its File node ${NODE} to delete it anyway.`,
      ]);
    });
  });

  describe('a File node named in the same call', () => {
    it('is not purged a second time when it went with the content that wrapped it', async () => {
      const contents = makeContents(
        [E1],
        wrapped({ wrappedFileIds: [FILE], fileIds: [FILE], nodeIds: [E2] }),
      );
      const files = makeFiles([E2]);
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Content' }, [E2]: { entityType: 'File' } },
      });

      const result = await wrapTool(graphUtility, { contents, files }).execute(CONTEXT, {
        entityIds: [E1, E2],
        mode: 'archive_and_delete',
      });

      expect(result.success).toBe(true);
      // Its node went with the content's purge, so neither the file purge nor the generic delete has it.
      expect(files.purge).not.toHaveBeenCalled();
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
      expect(result.data?.archivedEntityIds).toEqual([E1, E2]);
    });

    it('is still purged, and is the way to delete a kept file anyway', async () => {
      // The content went and the file stayed, because a message uses it. Naming its node is the explicit ask.
      const contents = makeContents(
        [E1],
        wrapped({ kept: [keptFile(FILE, { nodeId: E2, usedBy: { messageIds: [MESSAGE] } })] }),
      );
      const files = makeFiles([E2]);
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Content' }, [E2]: { entityType: 'File' } },
      });

      const result = await wrapTool(graphUtility, { contents, files }).execute(CONTEXT, {
        entityIds: [E1, E2],
        mode: 'archive_and_delete',
      });

      expect(result.success).toBe(true);
      expect(files.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E2]);
    });
  });

  describe('when the purge fails', () => {
    it('names the content whose photo is gone, and says that forgetting it again finishes the job', async () => {
      const contents = makeContents([E1]);

      contents.purge.mockRejectedValueOnce(
        new StoredObjectsDeletedError([E1], new Error('deadlock detected')),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'EXECUTION_ERROR',
        retryable: true,
        details: { storedObjectsDeletedFor: [E1] },
      });
      expect(result.error?.message).toContain('deadlock detected');
      expect(result.error?.message).toContain(`Forgetting them again finishes the job: ${E1}.`);
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
    });

    it('names the events whose photos are gone', async () => {
      const calendarEvents = makeCalendarEvents([E1]);

      calendarEvents.purge.mockRejectedValueOnce(
        new StoredObjectsDeletedError([E1], new Error('connection reset')),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Event' } } });

      const result = await wrapTool(graphUtility, { calendarEvents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({
        code: 'EXECUTION_ERROR',
        details: { storedObjectsDeletedFor: [E1] },
      });
      expect(result.error?.message).toContain(`Forgetting them again finishes the job: ${E1}.`);
    });

    it('does not call a foreign-key violation retryable, and does not promise that forgetting again helps', async () => {
      const contents = makeContents([E1]);

      contents.purge.mockRejectedValueOnce(
        new StoredObjectsDeletedError([E1], pgFailure('23503', { constraint: 'new_fkey', table: 'content' })),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { storedObjectsDeletedFor: [E1] },
      });
      expect(result.error?.message).toContain(
        `Retrying cannot finish the job until what references them is removed: ${E1}.`,
      );
      expect(result.error?.message).not.toContain('Forgetting them again finishes the job');
    });

    it('says nothing of half-gone files when the object store failed first, and nothing was deleted', async () => {
      const contents = makeContents([E1]);

      contents.purge.mockRejectedValueOnce(
        new Error(
          'The stored objects could not be deleted, so nothing was deleted from the database: ECONNREFUSED',
        ),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Content' } } });

      const result = await wrapTool(graphUtility, { contents }).execute(CONTEXT, {
        entityIds: [E1],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({ code: 'EXECUTION_ERROR', retryable: true });
      expect(result.error?.details).not.toHaveProperty('storedObjectsDeletedFor');
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
    });

    it('lists what an earlier purge destroyed together with the content whose photo is gone', async () => {
      const calendarEvents = makeCalendarEvents([E3]);
      const contents = makeContents([E1]);

      contents.purge.mockRejectedValueOnce(
        new StoredObjectsDeletedError([E1], new Error('connection reset')),
      );

      const graphUtility = makeGraphUtility({
        nodes: { [E3]: { entityType: 'Event' }, [E1]: { entityType: 'Content' } },
      });

      const result = await wrapTool(graphUtility, { calendarEvents, contents }).execute(CONTEXT, {
        entityIds: [E3, E1],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({
        details: { deletedEntityIds: [E3], storedObjectsDeletedFor: [E1] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E3}.`);
      expect(result.error?.message).toContain(`Forgetting them again finishes the job: ${E1}.`);
    });
  });
});

describe('ForgetKnowledgeTool message attachments, archive_and_delete', () => {
  const FILE = 'aaaaaaaa-0000-0000-0000-000000000001';
  const FILE_2 = 'aaaaaaaa-0000-0000-0000-000000000002';
  const COPY = 'aaaaaaaa-0000-0000-0000-0000000000c1';
  const NODE = 'bbbbbbbb-0000-0000-0000-000000000001';
  const OTHER_MESSAGE = 'cccccccc-0000-0000-0000-000000000002';
  const PHOTO = 'dddddddd-0000-0000-0000-000000000001';
  const PHOTO_2 = 'dddddddd-0000-0000-0000-000000000002';

  /** A tool whose only interesting collaborators are the graph and the services that purge what holds files. */
  function messageTool(
    graphUtility: ReturnType<typeof makeGraphUtility>,
    parts: {
      calendarEvents?: ReturnType<typeof makeCalendarEvents>;
      contents?: ReturnType<typeof makeContents>;
      communications?: ReturnType<typeof makeCommunications>;
      files?: ReturnType<typeof makeFiles>;
    },
  ) {
    return makeTool(
      graphUtility,
      makeSearchIndex(),
      parts.calendarEvents ?? makeCalendarEvents(),
      parts.contents ?? makeContents(),
      parts.communications ?? makeCommunications(),
      makeItems(),
      parts.files ?? makeFiles(),
    );
  }

  const forgetMessages = (
    graphUtility: ReturnType<typeof makeGraphUtility>,
    parts: Parameters<typeof messageTool>[1],
    entityIds: string[] = [E1],
  ) => messageTool(graphUtility, parts).execute(CONTEXT, { entityIds, mode: 'archive_and_delete' });

  describe('what it says went', () => {
    it('says which stored files went with a message, and the copies that went with them, in the message’s own words', async () => {
      const communications = makeCommunications([E1], {
        files: wrapped({ wrappedFileIds: [FILE], fileIds: [FILE, COPY], nodeIds: [NODE] }),
      });
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([E1]);
      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the message that held them, because nothing else used them: stored file(s) ${FILE}, and 1 copy(ies) of them (previews, thumbnails, playback versions).`,
      ]);
    });

    it('says which content rows went with a message that nobody named', async () => {
      const communications = makeCommunications([E1], { contentIds: [PHOTO, PHOTO_2] });
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      expect(result.data?.warnings).toEqual([
        `Also deleted, because a message named here carried them as attachments: content ${PHOTO}, ${PHOTO_2}.`,
      ]);
    });

    it('lists the first few of a long run of content rows and counts the rest, so that a chat of photos is one line', async () => {
      const ids = Array.from({ length: 8 }, (_, index) => `dddddddd-0000-0000-0000-00000000030${index}`);
      const communications = makeCommunications([E1], { contentIds: ids });
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      expect(result.data?.warnings).toEqual([
        `Also deleted, because a message named here carried them as attachments: content ${ids.slice(0, 5).join(', ')} and 3 more.`,
      ]);
    });

    it('says the content rows first, then the files, when a message took both', async () => {
      const communications = makeCommunications([E1], {
        contentIds: [PHOTO],
        files: wrapped({ wrappedFileIds: [FILE], fileIds: [FILE] }),
      });
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      expect(result.data?.warnings).toEqual([
        `Also deleted, because a message named here carried them as attachments: content ${PHOTO}.`,
        `Also deleted, along with the message that held them, because nothing else used them: stored file(s) ${FILE}.`,
      ]);
    });

    it('says when a stored object stayed because another file record still names it', async () => {
      const communications = makeCommunications([E1], {
        files: wrapped({ wrappedFileIds: [FILE], fileIds: [FILE], keptObjects: 2 }),
      });
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      expect(result.data?.warnings).toContain(
        '2 stored object(s) were not deleted because another file record still names them.',
      );
    });

    it('says nothing of files or content when the messages named none', async () => {
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications: makeCommunications([E1]) });

      expect(result.data?.warnings).toBeUndefined();
    });
  });

  describe('what it says stayed, and why', () => {
    it('names a file that another message and other content still use, and the File node that deletes it anyway', async () => {
      const communications = makeCommunications([E1], {
        files: wrapped({
          kept: [keptFile(FILE, { nodeId: NODE, usedBy: { messageIds: [OTHER_MESSAGE], contentIds: [E2] } })],
        }),
      });
      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      // A kept file is not a failure: the message went, and the call says what is left and why.
      expect(result.success).toBe(true);
      expect(result.data?.warnings).toEqual([
        `Not deleted: stored file ${FILE} is still used by message(s) ${OTHER_MESSAGE}; other content ${E2}. Forget its File node ${NODE} to delete it anyway.`,
      ]);
    });
  });

  describe('a call that names what keeps a file', () => {
    it('does not say a file stayed when a later purge in the same call deleted it', async () => {
      // The content went first and kept the file, because the message used it. Then the message went, and
      // nothing used it any more. Both are true in turn, and only the end of it is what the user is told.
      const contents = makeContents(
        [E2],
        wrapped({ kept: [keptFile(FILE, { nodeId: NODE, usedBy: { messageIds: [E1] } })] }),
      );
      const communications = makeCommunications([E1], {
        files: wrapped({ wrappedFileIds: [FILE], fileIds: [FILE, COPY] }),
      });
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Communication' }, [E2]: { entityType: 'Content' } },
      });

      const result = await forgetMessages(graphUtility, { contents, communications }, [E1, E2]);

      expect(result.success).toBe(true);
      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the message that held them, because nothing else used them: stored file(s) ${FILE}, and 1 copy(ies) of them (previews, thumbnails, playback versions).`,
      ]);
    });

    it('says what the last purge found when a file stayed through all of them', async () => {
      const contents = makeContents(
        [E2],
        wrapped({ kept: [keptFile(FILE, { usedBy: { messageIds: [E1], contentIds: [E3] } })] }),
      );
      const communications = makeCommunications([E1], {
        files: wrapped({ kept: [keptFile(FILE, { usedBy: { contentIds: [E3] } })] }),
      });
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Communication' }, [E2]: { entityType: 'Content' } },
      });

      const result = await forgetMessages(graphUtility, { contents, communications }, [E1, E2]);

      // One line, and the message that was forgotten since is not named as what keeps it.
      expect(result.data?.warnings).toEqual([
        `Not deleted: stored file ${FILE} is still used by other content ${E3}.`,
      ]);
    });

    it('lists the files that stayed across the purges together, ten at a time', async () => {
      const kept = (from: number) =>
        Array.from({ length: 6 }, (_, index) =>
          keptFile(`aaaaaaaa-0000-0000-0000-0000000004${String(from + index).padStart(2, '0')}`, {
            usedBy: { messageIds: [OTHER_MESSAGE] },
          }),
        );
      const contents = makeContents([E2], wrapped({ kept: kept(0) }));
      const communications = makeCommunications([E1], { files: wrapped({ kept: kept(6) }) });
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Communication' }, [E2]: { entityType: 'Content' } },
      });

      const result = await forgetMessages(graphUtility, { contents, communications }, [E1, E2]);

      const warnings = result.data?.warnings ?? [];

      expect(warnings).toHaveLength(11);
      expect(warnings.slice(0, 10).every((line) => line.startsWith('Not deleted: stored file '))).toBe(true);
      expect(warnings[10]).toBe(
        '2 more stored file(s) were not deleted either, because something else still uses them.',
      );
    });

    it('says what went and what stayed in the same call, each file once', async () => {
      const contents = makeContents(
        [E2],
        wrapped({ kept: [keptFile(FILE_2, { nodeId: NODE, usedBy: { messageIds: [OTHER_MESSAGE] } })] }),
      );
      const communications = makeCommunications([E1], {
        files: wrapped({
          wrappedFileIds: [FILE],
          fileIds: [FILE],
          kept: [keptFile(FILE_2, { nodeId: NODE, usedBy: { messageIds: [OTHER_MESSAGE] } })],
        }),
      });
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Communication' }, [E2]: { entityType: 'Content' } },
      });

      const result = await forgetMessages(graphUtility, { contents, communications }, [E1, E2]);

      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the message that held them, because nothing else used them: stored file(s) ${FILE}.`,
        `Not deleted: stored file ${FILE_2} is still used by message(s) ${OTHER_MESSAGE}. Forget its File node ${NODE} to delete it anyway.`,
      ]);
    });
  });

  describe('a File node named in the same call', () => {
    it('is not purged a second time when it went with the message that named it', async () => {
      const communications = makeCommunications([E1], {
        files: wrapped({ wrappedFileIds: [FILE], fileIds: [FILE], nodeIds: [E2] }),
      });
      const files = makeFiles([E2]);
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Communication' }, [E2]: { entityType: 'File' } },
      });

      const result = await forgetMessages(graphUtility, { communications, files }, [E1, E2]);

      expect(result.success).toBe(true);
      // Its node went with the message's purge, so neither the file purge nor the generic delete has it.
      expect(files.purge).not.toHaveBeenCalled();
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
      expect(result.data?.archivedEntityIds).toEqual([E1, E2]);
    });

    it('is still purged when the message kept its file, which is the way to delete it anyway', async () => {
      const communications = makeCommunications([E1], {
        files: wrapped({ kept: [keptFile(FILE, { nodeId: E2, usedBy: { messageIds: [OTHER_MESSAGE] } })] }),
      });
      const files = makeFiles([E2]);
      const graphUtility = makeGraphUtility({
        nodes: { [E1]: { entityType: 'Communication' }, [E2]: { entityType: 'File' } },
      });

      const result = await forgetMessages(graphUtility, { communications, files }, [E1, E2]);

      expect(result.success).toBe(true);
      expect(files.purge).toHaveBeenCalledWith({ userId: CONTEXT.userId }, [E2]);
    });

    it('is listed as already deleted when a later purge fails, though it was only said at the end', async () => {
      // The warnings are written once every purge has run, and a failure writes none, so the node that went
      // with the message has to be marked when the message's purge returns, not when the call is reported.
      const communications = makeCommunications([E1], {
        files: wrapped({ wrappedFileIds: [FILE], fileIds: [FILE], nodeIds: [E2] }),
      });
      const people = makePeople([E3]);

      people.purge.mockRejectedValueOnce(new Error('connection reset'));

      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Communication' },
          [E2]: { entityType: 'File' },
          [E3]: { entityType: 'Person' },
        },
      });

      const result = await toolWith(graphUtility, { communications, people }).execute(CONTEXT, {
        entityIds: [E1, E2, E3],
        mode: 'archive_and_delete',
      });

      expect(result.success).toBe(false);
      expect(result.error?.details).toMatchObject({ deletedEntityIds: [E1, E2] });
    });
  });

  describe('when the purge fails', () => {
    it('names the messages whose photos are gone, and says that forgetting them again finishes the job', async () => {
      const communications = makeCommunications([E1]);

      communications.purge.mockRejectedValueOnce(
        new StoredObjectsDeletedError([E1], new Error('deadlock detected')),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'EXECUTION_ERROR',
        retryable: true,
        details: { storedObjectsDeletedFor: [E1] },
      });
      expect(result.error?.message).toContain('deadlock detected');
      expect(result.error?.message).toContain(`Forgetting them again finishes the job: ${E1}.`);
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
    });

    it('does not call a foreign-key violation retryable, and does not promise that forgetting again helps', async () => {
      const communications = makeCommunications([E1]);

      communications.purge.mockRejectedValueOnce(
        new StoredObjectsDeletedError(
          [E1],
          pgFailure('23503', { constraint: 'new_fkey', table: 'communications' }),
        ),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { storedObjectsDeletedFor: [E1] },
      });
      expect(result.error?.message).toContain(
        `Retrying cannot finish the job until what references them is removed: ${E1}.`,
      );
      expect(result.error?.message).not.toContain('Forgetting them again finishes the job');
    });

    it('lists what an earlier purge destroyed together with the message whose photo is gone', async () => {
      const calendarEvents = makeCalendarEvents([E3]);
      const communications = makeCommunications([E1]);

      communications.purge.mockRejectedValueOnce(
        new StoredObjectsDeletedError([E1], new Error('connection reset')),
      );

      const graphUtility = makeGraphUtility({
        nodes: { [E3]: { entityType: 'Event' }, [E1]: { entityType: 'Communication' } },
      });

      const result = await forgetMessages(graphUtility, { calendarEvents, communications }, [E3, E1]);

      expect(result.error).toMatchObject({
        details: { deletedEntityIds: [E3], storedObjectsDeletedFor: [E1] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E3}.`);
      expect(result.error?.message).toContain(`Forgetting them again finishes the job: ${E1}.`);
    });

    it('says nothing of half-gone files when the object store failed first, and nothing was deleted', async () => {
      const communications = makeCommunications([E1]);

      communications.purge.mockRejectedValueOnce(
        new Error(
          'The stored objects could not be deleted, so nothing was deleted from the database: ECONNREFUSED',
        ),
      );

      const graphUtility = makeGraphUtility({ nodes: { [E1]: { entityType: 'Communication' } } });

      const result = await forgetMessages(graphUtility, { communications });

      expect(result.error).toMatchObject({ code: 'EXECUTION_ERROR', retryable: true });
      expect(result.error?.details).not.toHaveProperty('storedObjectsDeletedFor');
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
    });
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

  describe('with communications', () => {
    it('refuses a communication purge whole, and says nothing was destroyed, when it is the first thing to be purged', async () => {
      const communications = makeCommunications([E1, E2]);
      communications.purge.mockRejectedValueOnce(pgFailure('23503', FK));
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Communication' },
          [E2]: { entityType: 'Communication' },
          [E3]: { entityType: 'Concept' },
        },
      });
      const tool = makeTool(
        graphUtility,
        makeSearchIndex(),
        makeCalendarEvents(),
        makeContents(),
        communications,
      );

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({ code: 'CONSTRAINT_VIOLATION', retryable: false });
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(result.error?.message).not.toContain('Already deleted');
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names the events and content already destroyed when it is the communication purge that is refused', async () => {
      // Each of those committed in its own transaction, and cannot be undone.
      const calendarEvents = makeCalendarEvents([E1]);
      const contents = makeContents([E2]);
      const communications = makeCommunications([E3]);
      communications.purge.mockRejectedValueOnce(pgFailure('23503', FK));
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Event' },
          [E2]: { entityType: 'Content' },
          [E3]: { entityType: 'Communication' },
        },
      });
      const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents, contents, communications);

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [E1, E2] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}, ${E2}.`);
      // Nothing after the refused purge was touched.
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names the communications already destroyed when it is the rest of the call that is refused', async () => {
      const communications = makeCommunications([E1, E2]);
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Communication' },
          [E2]: { entityType: 'Communication' },
          [E3]: { entityType: 'Person' },
        },
      });
      graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure('23503', FK));
      const tool = makeTool(
        graphUtility,
        makeSearchIndex(),
        makeCalendarEvents(),
        makeContents(),
        communications,
      );

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { deletedEntityIds: [E1, E2] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}, ${E2}.`);
    });
  });

  describe('with items', () => {
    it('refuses an item purge whole, and says nothing was destroyed, when it is the first thing to be purged', async () => {
      const items = makeItems([E1, E2]);
      items.purge.mockRejectedValueOnce(pgFailure('23503', FK));
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Item' },
          [E2]: { entityType: 'Item' },
          [E3]: { entityType: 'Concept' },
        },
      });
      const tool = makeTool(
        graphUtility,
        makeSearchIndex(),
        makeCalendarEvents(),
        makeContents(),
        makeCommunications(),
        items,
      );

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({ code: 'CONSTRAINT_VIOLATION', retryable: false });
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(result.error?.message).not.toContain('Already deleted');
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names the events, content and communications already destroyed when it is the item purge that is refused', async () => {
      // Each of those committed in its own transaction, and cannot be undone.
      const calendarEvents = makeCalendarEvents([E1]);
      const contents = makeContents([E2]);
      const communications = makeCommunications([E3]);
      const items = makeItems([E_MISSING]);
      items.purge.mockRejectedValueOnce(pgFailure('23503', FK));
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Event' },
          [E2]: { entityType: 'Content' },
          [E3]: { entityType: 'Communication' },
          [E_MISSING]: { entityType: 'Item' },
        },
      });
      const tool = makeTool(graphUtility, makeSearchIndex(), calendarEvents, contents, communications, items);

      const result = await tool.execute(CONTEXT, {
        entityIds: [E1, E2, E3, E_MISSING],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [E1, E2, E3] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}, ${E2}, ${E3}.`);
      // Nothing after the refused purge was touched.
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names the items already destroyed when it is the rest of the call that is refused', async () => {
      const items = makeItems([E1, E2]);
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Item' },
          [E2]: { entityType: 'Item' },
          [E3]: { entityType: 'Person' },
        },
      });
      graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure('23503', FK));
      const tool = makeTool(
        graphUtility,
        makeSearchIndex(),
        makeCalendarEvents(),
        makeContents(),
        makeCommunications(),
        items,
      );

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { deletedEntityIds: [E1, E2] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}, ${E2}.`);
    });
  });

  describe('with people, places and concepts', () => {
    it('refuses a person purge whole, and says nothing was destroyed, when it is the first thing to be purged', async () => {
      const people = makePeople([E1, E2]);
      people.purge.mockRejectedValueOnce(pgFailure('23503', FK));
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Person' },
          [E2]: { entityType: 'Person' },
          [E3]: { entityType: 'Organization' },
        },
      });
      const tool = toolWith(graphUtility, { people });

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({ code: 'CONSTRAINT_VIOLATION', retryable: false });
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(result.error?.message).not.toContain('Already deleted');
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names everything already destroyed when it is the concept purge that is refused', async () => {
      // Each purge committed in its own transaction, and cannot be undone.
      const calendarEvents = makeCalendarEvents([E1]);
      const people = makePeople([E2]);
      const places = makePlaces([E3]);
      const concepts = makeConcepts([E_MISSING]);
      concepts.purge.mockRejectedValueOnce(pgFailure('23503', FK));
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Event' },
          [E2]: { entityType: 'Person' },
          [E3]: { entityType: 'Place' },
          [E_MISSING]: { entityType: 'Concept' },
        },
      });
      const tool = toolWith(graphUtility, { calendarEvents, people, places, concepts });

      const result = await tool.execute(CONTEXT, {
        entityIds: [E1, E2, E3, E_MISSING],
        mode: 'archive_and_delete',
      });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { deletedEntityIds: [E1, E2, E3] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}, ${E2}, ${E3}.`);
      // Nothing after the refused purge was touched.
      expect(graphUtility.deactivateEntities).not.toHaveBeenCalled();
    });

    it('names the people already destroyed when it is the rest of the call that is refused', async () => {
      const people = makePeople([E1, E2]);
      const graphUtility = makeGraphUtility({
        nodes: {
          [E1]: { entityType: 'Person' },
          [E2]: { entityType: 'Contact' },
          [E3]: { entityType: 'Organization' },
        },
      });
      graphUtility.deactivateEntities.mockRejectedValueOnce(pgFailure('23503', FK));
      const tool = toolWith(graphUtility, { people });

      const result = await tool.execute(CONTEXT, { entityIds: [E1, E2, E3], mode: 'archive_and_delete' });

      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { deletedEntityIds: [E1, E2] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${E1}, ${E2}.`);
    });
  });
});
