import { type RequestContext } from '@ci/common/context';

import { type SearchInput } from '../../types/SearchInput';
import { SearchResolver } from '../SearchResolver';

const ctx = { userId: 'user-1' } as unknown as RequestContext;

type Identifier = { type: string; id: string };
type Entry = { type: string; id: string; entity: Record<string, unknown> };

function makeResolver() {
  const searchService = { search: jest.fn().mockResolvedValue([] as Identifier[]) };
  const tagService = {
    getEntitiesForTags: jest.fn().mockResolvedValue([] as Identifier[]),
    searchByLabel: jest.fn().mockResolvedValue([]),
  };
  // Every timed-source service also exposes a real-COUNT(*) `countEntitiesForX`
  // counterpart (see SearchResolver.countTimedEntities) alongside its
  // `getEntitiesForX` fetch — stubbed to 0 here since these tests assert on the
  // fetch calls' args/results, not on totalCount.
  const eventService = {
    getEntitiesForEvents: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForEvents: jest.fn().mockResolvedValue(0),
  };
  const browserActivityService = {
    getEntitiesForBrowserActivities: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForBrowserActivities: jest.fn().mockResolvedValue(0),
  };
  const communicationService = {
    getEntitiesForCommunications: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForCommunications: jest.fn().mockResolvedValue(0),
  };
  const conceptService = {
    getEntitiesForConcepts: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForConcepts: jest.fn().mockResolvedValue(0),
  };
  const contentService = {
    getEntitiesForContents: jest.fn().mockResolvedValue([] as Identifier[]),
    // The query path also reaches events through matching media; nothing here has any.
    findEventIdsForMedia: jest.fn().mockResolvedValue([] as string[]),
    countEntitiesForContents: jest.fn().mockResolvedValue(0),
  };
  const itemService = {
    getEntitiesForItems: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForItems: jest.fn().mockResolvedValue(0),
  };
  const noteService = {
    getEntitiesForNotes: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForNotes: jest.fn().mockResolvedValue(0),
  };
  const personService = {
    getEntitiesForPeople: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForPeople: jest.fn().mockResolvedValue(0),
  };
  const placeService = {
    getEntitiesForPlaces: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForPlaces: jest.fn().mockResolvedValue(0),
  };
  const answerService = {
    getEntitiesForAnswers: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForAnswers: jest.fn().mockResolvedValue(0),
  };
  const entityResolutionService = { resolve: jest.fn().mockResolvedValue(new Map<string, Entry>()) };
  const savedSearchService = { findByShareToken: jest.fn().mockResolvedValue(null) };

  const fileService = {
    getEntitiesForFiles: jest.fn().mockResolvedValue([]),
    countEntitiesForFiles: jest.fn().mockResolvedValue(0),
  };
  const fileChunkService = {
    getEntitiesForFileChunks: jest.fn().mockResolvedValue([]),
    countEntitiesForFileChunks: jest.fn().mockResolvedValue(0),
  };
  const productModelService = {
    getEntitiesForProducts: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForProducts: jest.fn().mockResolvedValue(0),
  };
  const receiptService = {
    getEntitiesForReceipts: jest.fn().mockResolvedValue([] as Identifier[]),
    countEntitiesForReceipts: jest.fn().mockResolvedValue(0),
  };
  const resolver = new SearchResolver(
    browserActivityService as never,
    communicationService as never,
    conceptService as never,
    contentService as never,
    entityResolutionService as never,
    eventService as never,
    fileService as never,
    fileChunkService as never,
    itemService as never,
    noteService as never,
    personService as never,
    placeService as never,
    productModelService as never,
    receiptService as never,
    answerService as never,
    savedSearchService as never,
    {
      // Authorizes with no ceiling: these suites are not about consent, and a
      // share created before `share_max_disclosure` existed reads exactly this way.
      authorize: jest.fn().mockResolvedValue({ grantId: 'grant-test', ceiling: undefined }),
      recordRead: jest.fn().mockResolvedValue(undefined),
    } as never,
    searchService as never,
    tagService as never,
    { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
  );

  // Bypass the real GraphQL type mappers; the unit under test is the filter/sort composition.
  jest
    .spyOn(resolver as unknown as { toSearchResult: (entry: Entry) => unknown }, 'toSearchResult')
    .mockImplementation((entry: Entry) => ({ id: `${entry.type}:${entry.id}`, type: entry.type }));

  return {
    resolver,
    searchService,
    tagService,
    eventService,
    browserActivityService,
    communicationService,
    entityResolutionService,
    fileService,
    fileChunkService,
    contentService,
    noteService,
    personService,
    placeService,
    conceptService,
    itemService,
    productModelService,
    receiptService,
  };
}

function resolveMap(entries: Entry[]): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (const entry of entries) {
    map.set(`${entry.type}:${entry.id}`, entry);
  }

  return map;
}

const idsResolvedTo = (mock: jest.Mock): Identifier[] => mock.mock.calls[0][1] as Identifier[];
const nodeIds = (connection: { edges: { node: { id: string } }[] }) =>
  connection.edges.map((edge) => edge.node.id);

describe('SearchResolver.search — combinable filters', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ANDs query and tags (intersect candidates by raw type:id before resolving)', async () => {
    const { resolver, searchService, tagService, entityResolutionService } = makeResolver();
    searchService.search.mockResolvedValue([
      { type: 'content', id: 'c1' },
      { type: 'event', id: 'e1' },
      { type: 'note', id: 'n1' },
    ]);
    tagService.getEntitiesForTags.mockResolvedValue([
      { type: 'event', id: 'e1' },
      { type: 'person', id: 'p9' },
    ]);

    await resolver.search(ctx, { query: 'hi', tags: ['t'] } as SearchInput);

    expect(idsResolvedTo(entityResolutionService.resolve)).toEqual([{ type: 'event', id: 'e1' }]);
  });

  it('ANDs tags and entity types', async () => {
    const { resolver, tagService, entityResolutionService } = makeResolver();
    tagService.getEntitiesForTags.mockResolvedValue([
      { type: 'event', id: 'e1' },
      { type: 'note', id: 'n1' },
      { type: 'person', id: 'p1' },
    ]);

    await resolver.search(ctx, { tags: ['t'], includeTypes: ['note', 'person'] } as SearchInput);

    expect(idsResolvedTo(entityResolutionService.resolve)).toEqual([
      { type: 'note', id: 'n1' },
      { type: 'person', id: 'p1' },
    ]);
  });

  it('ANDs a date range onto a query, dropping out-of-range and timestamp-less entities', async () => {
    const { resolver, searchService, entityResolutionService } = makeResolver();
    searchService.search.mockResolvedValue([
      { type: 'event', id: 'e1' },
      { type: 'note', id: 'n2' },
      { type: 'event', id: 'e3' },
    ]);
    entityResolutionService.resolve.mockResolvedValue(
      resolveMap([
        { type: 'event', id: 'e1', entity: { startTime: new Date('2026-01-15') } },
        { type: 'note', id: 'n2', entity: {} },
        { type: 'event', id: 'e3', entity: { startTime: new Date('2026-03-20') } },
      ]),
    );

    const result = await resolver.search(ctx, {
      query: 'hi',
      startTime: '2026-02-01',
      endTime: '2026-04-01',
    } as SearchInput);

    expect(nodeIds(result)).toEqual(['event:e3']);
    expect(result.totalCount).toBe(1);
  });

  it('sorts by time ascending and descending', async () => {
    const entries: Entry[] = [
      { type: 'event', id: 'old', entity: { startTime: new Date('2026-01-01') } },
      { type: 'event', id: 'new', entity: { startTime: new Date('2026-05-01') } },
    ];

    const asc = makeResolver();
    asc.searchService.search.mockResolvedValue(entries.map(({ type, id }) => ({ type, id })));
    asc.entityResolutionService.resolve.mockResolvedValue(resolveMap(entries));
    const ascResult = await asc.resolver.search(ctx, {
      query: 'hi',
      sortBy: 'time',
      sortOrder: 'asc',
    } as SearchInput);
    expect(nodeIds(ascResult)).toEqual(['event:old', 'event:new']);

    const desc = makeResolver();
    desc.searchService.search.mockResolvedValue(entries.map(({ type, id }) => ({ type, id })));
    desc.entityResolutionService.resolve.mockResolvedValue(resolveMap(entries));
    const descResult = await desc.resolver.search(ctx, {
      query: 'hi',
      sortBy: 'time',
      sortOrder: 'desc',
    } as SearchInput);
    expect(nodeIds(descResult)).toEqual(['event:new', 'event:old']);
  });

  it('falls back to recent timed entities when no filter signal is provided', async () => {
    const { resolver, eventService, browserActivityService, communicationService, fileService } =
      makeResolver();

    await resolver.search(ctx, {} as SearchInput);

    expect(eventService.getEntitiesForEvents).toHaveBeenCalledTimes(1);
    expect(browserActivityService.getEntitiesForBrowserActivities).toHaveBeenCalledTimes(1);
    expect(communicationService.getEntitiesForCommunications).toHaveBeenCalledTimes(1);
    // Files are part of the default browse like every other indexed type — the
    // What picker's File entry is the one control over whether they show up.
    expect(fileService.getEntitiesForFiles).toHaveBeenCalledTimes(1);
    // No filters -> end bound to "now" so recent items are returned, not all history.
    const eventOptions = eventService.getEntitiesForEvents.mock.calls[0][1] as { endTime?: Date };
    expect(eventOptions.endTime).toBeInstanceOf(Date);
  });

  // Files used to be opted *out* of the timed browse unless a caller passed
  // includeFiles — which only the gallery did. That made the same explorer URL
  // mean different things view to view, and made the File type picker a no-op
  // everywhere else. Files are now part of the default browse; the type filter
  // is the single control over whether they appear.
  describe('includeFiles (files in the timed browse)', () => {
    it('interleaves files with the other timed types by default', async () => {
      const { resolver, eventService, fileService, fileChunkService, entityResolutionService } =
        makeResolver();
      eventService.getEntitiesForEvents.mockResolvedValue([{ type: 'event', id: 'e1' }]);
      fileService.getEntitiesForFiles.mockResolvedValue([{ type: 'file', id: 'f1' }]);

      await resolver.search(ctx, {} as SearchInput);

      expect(eventService.getEntitiesForEvents).toHaveBeenCalledTimes(1);
      expect(fileService.getEntitiesForFiles).toHaveBeenCalledTimes(1);
      // File chunks stay includeTypes-only — a document's many same-timestamp
      // chunks would still bury the browse.
      expect(fileChunkService.getEntitiesForFileChunks).not.toHaveBeenCalled();
      expect(idsResolvedTo(entityResolutionService.resolve)).toEqual([
        { type: 'event', id: 'e1' },
        { type: 'file', id: 'f1' },
      ]);
    });

    it('honours an explicit type filter that narrows to files', async () => {
      const { resolver, fileService, eventService } = makeResolver();
      fileService.getEntitiesForFiles.mockResolvedValue([{ type: 'file', id: 'f1' }]);

      await resolver.search(ctx, { includeTypes: ['file'] } as SearchInput);

      expect(fileService.getEntitiesForFiles).toHaveBeenCalledTimes(1);
      expect(eventService.getEntitiesForEvents).not.toHaveBeenCalled();
    });

    it('still honours an explicit type filter that excludes files', async () => {
      const { resolver, fileService } = makeResolver();

      await resolver.search(ctx, { excludeTypes: ['file'] } as SearchInput);

      expect(fileService.getEntitiesForFiles).not.toHaveBeenCalled();
    });

    it('lets a caller opt files out without touching excludeTypes', async () => {
      const { resolver, fileService, eventService } = makeResolver();

      await resolver.search(ctx, { includeFiles: false } as SearchInput);

      expect(fileService.getEntitiesForFiles).not.toHaveBeenCalled();
      expect(eventService.getEntitiesForEvents).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * VIEW-01. The unfiltered browse is a chronology, but ten of the thirteen
 * result types are ordered by `updated_at` — the row-WRITE time — which a bulk
 * import parks at "now". Measured on the QA appliance, 22,145 rows sat ahead of
 * the newest genuinely-dated memory: 11,211 event-linked media content rows,
 * 9,753 people, 1,178 places and 3 others. Reordering within the page cannot
 * reach them, because the first server pages are entirely made of them.
 *
 * These pin the two server-side gates that remove them, and — just as
 * important — pin that they are removed from the BROWSE only.
 */
describe('SearchResolver.search — undated types stay out of the unfiltered browse (VIEW-01)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not fetch person / place / concept / item for a browse with no filters', async () => {
    const { resolver, personService, placeService, conceptService, itemService } = makeResolver();

    await resolver.search(ctx, {} as SearchInput);

    expect(personService.getEntitiesForPeople).not.toHaveBeenCalled();
    expect(placeService.getEntitiesForPlaces).not.toHaveBeenCalled();
    expect(conceptService.getEntitiesForConcepts).not.toHaveBeenCalled();
    expect(itemService.getEntitiesForItems).not.toHaveBeenCalled();
  });

  it('still fetches the types that carry a real domain timestamp', async () => {
    const { resolver, eventService, communicationService, browserActivityService } = makeResolver();

    await resolver.search(ctx, {} as SearchInput);

    expect(eventService.getEntitiesForEvents).toHaveBeenCalledTimes(1);
    expect(communicationService.getEntitiesForCommunications).toHaveBeenCalledTimes(1);
    expect(browserActivityService.getEntitiesForBrowserActivities).toHaveBeenCalledTimes(1);
  });

  it('fetches a gated type as soon as the caller names it', async () => {
    const { resolver, personService, placeService } = makeResolver();

    await resolver.search(ctx, { includeTypes: ['person', 'place'] } as SearchInput);

    expect(personService.getEntitiesForPeople).toHaveBeenCalledTimes(1);
    expect(placeService.getEntitiesForPlaces).toHaveBeenCalledTimes(1);
  });

  it('stamps appearedAt from person sortTime so date buckets use appearance, not import time', async () => {
    const { resolver, personService, entityResolutionService } = makeResolver();
    const appearedAt = new Date('2024-03-04T12:00:00.000Z');
    personService.getEntitiesForPeople.mockResolvedValue([
      { type: 'person', id: 'p1', sortTime: appearedAt },
    ]);
    entityResolutionService.resolve.mockResolvedValue(
      resolveMap([
        {
          type: 'person',
          id: 'p1',
          entity: { id: 'p1', name: 'Ada', updatedAt: new Date('2026-08-01T00:00:00.000Z') },
        },
      ]),
    );

    await resolver.search(ctx, {
      includeTypes: ['person'],
      startTime: '2024-03-01T00:00:00.000Z',
      endTime: '2024-03-31T23:59:59.000Z',
    } as SearchInput);

    const toSearchResult = (resolver as unknown as { toSearchResult: { mock: { calls: Array<[Entry]> } } })
      .toSearchResult;
    expect(toSearchResult.mock.calls[0][0].entity).toEqual(expect.objectContaining({ appearedAt }));
  });

  it('fetches a gated type the What picker kept by excluding everything else', async () => {
    const { resolver, personService, fileChunkService, eventService } = makeResolver();

    await resolver.search(ctx, {
      excludeTypes: [
        'browser-activity',
        'communication',
        'content',
        'event',
        'file',
        'note',
        'place',
        'product',
        'receipt',
        'item',
        'answer',
        'concept',
      ],
    } as SearchInput);

    expect(personService.getEntitiesForPeople).toHaveBeenCalledTimes(1);
    expect(eventService.getEntitiesForEvents).not.toHaveBeenCalled();
    // file-chunk is not in the picker, so an exclude-list must not opt it in.
    expect(fileChunkService.getEntitiesForFileChunks).not.toHaveBeenCalled();
  });

  // The gate must not leak into search: a user looking for a person by name
  // must still find them.
  it('leaves the query path alone — a gated type is still searchable', async () => {
    const { resolver, searchService, entityResolutionService } = makeResolver();
    searchService.search.mockResolvedValue([{ type: 'person', id: 'p1' }]);

    await resolver.search(ctx, { query: 'ada' } as SearchInput);

    expect(idsResolvedTo(entityResolutionService.resolve)).toEqual([{ type: 'person', id: 'p1' }]);
  });

  it('leaves the tag path alone — a gated type is still reachable by tag', async () => {
    const { resolver, tagService, entityResolutionService } = makeResolver();
    tagService.getEntitiesForTags.mockResolvedValue([{ type: 'place', id: 'pl1' }]);

    await resolver.search(ctx, { tags: ['holiday'] } as SearchInput);

    expect(idsResolvedTo(entityResolutionService.resolve)).toEqual([{ type: 'place', id: 'pl1' }]);
  });

  // Every event-linked content row is a facet of an event the same merge
  // already returns; on the QA appliance all 11,211 of them are type='media'
  // pointing at the very binary their event renders, so the browse showed each
  // photo twice AND showed both copies ahead of the real timeline.
  it('drops event-linked content from the browse fetch and from its total', async () => {
    const { resolver, contentService } = makeResolver();

    await resolver.search(ctx, {} as SearchInput);

    expect(contentService.getEntitiesForContents).toHaveBeenCalledTimes(1);
    expect(contentService.getEntitiesForContents.mock.calls[0][1]).toMatchObject({
      excludeEventLinked: true,
    });
    // The denominator the footer renders (VIEW-08) must count exactly what the
    // fetch returns, or "30 of N" lies.
    expect(contentService.countEntitiesForContents.mock.calls[0][1]).toMatchObject({
      excludeEventLinked: true,
    });
  });

  it('does not apply the event-linked exclusion to a tag search', async () => {
    const { resolver, tagService, contentService } = makeResolver();
    tagService.getEntitiesForTags.mockResolvedValue([{ type: 'content', id: 'c1' }]);

    await resolver.search(ctx, { tags: ['holiday'] } as SearchInput);

    expect(contentService.getEntitiesForContents).not.toHaveBeenCalled();
  });

  // The gate must not touch `file`: #2110 deliberately made files part of the
  // default timeline (opt-OUT via includeFiles). They remain the residual
  // undated head this change does not address.
  it('leaves files in the default browse, as #2110 decided', async () => {
    const { resolver, fileService } = makeResolver();

    await resolver.search(ctx, {} as SearchInput);

    expect(fileService.getEntitiesForFiles).toHaveBeenCalledTimes(1);
  });
});

/**
 * B1. "Products" and "Receipts" are members of the search union and entries in
 * the What picker, but the timed browse's type fan-out never had a branch for
 * either — so selecting one with no query ran a merge that asked no service
 * anything and returned an empty page with totalCount 0, permanently. A filter
 * that can never return anything is worse than no filter; these pin both halves
 * of the fix (the fetch AND the count) and the gate that keeps them off the
 * unfiltered chronology.
 */
describe('SearchResolver.search — products and receipts are browsable (B1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches AND counts products when the caller names the type', async () => {
    const { resolver, productModelService, entityResolutionService } = makeResolver();
    productModelService.getEntitiesForProducts.mockResolvedValue([{ type: 'product', id: 'pr1' }]);
    productModelService.countEntitiesForProducts.mockResolvedValue(3);
    entityResolutionService.resolve.mockResolvedValue(
      resolveMap([{ type: 'product', id: 'pr1', entity: { updatedAt: new Date('2026-02-01') } }]),
    );

    const result = await resolver.search(ctx, { includeTypes: ['product'] } as SearchInput);

    expect(productModelService.getEntitiesForProducts).toHaveBeenCalledTimes(1);
    expect(nodeIds(result)).toEqual(['product:pr1']);
    // The denominator the footer renders has to come from the same predicate as
    // the page, not from the page's length.
    expect(result.totalCount).toBe(3);
  });

  it('fetches AND counts receipts when the caller names the type', async () => {
    const { resolver, receiptService, entityResolutionService } = makeResolver();
    receiptService.getEntitiesForReceipts.mockResolvedValue([{ type: 'receipt', id: 'rc1' }]);
    receiptService.countEntitiesForReceipts.mockResolvedValue(2);
    entityResolutionService.resolve.mockResolvedValue(
      resolveMap([{ type: 'receipt', id: 'rc1', entity: { purchasedAt: new Date('2026-03-04') } }]),
    );

    const result = await resolver.search(ctx, { includeTypes: ['receipt'] } as SearchInput);

    expect(receiptService.getEntitiesForReceipts).toHaveBeenCalledTimes(1);
    expect(nodeIds(result)).toEqual(['receipt:rc1']);
    expect(result.totalCount).toBe(2);
  });

  // A catalog model has no domain time and a receipt's is nullable; both would
  // otherwise land at import time ahead of the whole timeline. Same gate as
  // person / place / concept / item.
  it('keeps both out of a browse with no filters', async () => {
    const { resolver, productModelService, receiptService } = makeResolver();

    await resolver.search(ctx, {} as SearchInput);

    expect(productModelService.getEntitiesForProducts).not.toHaveBeenCalled();
    expect(productModelService.countEntitiesForProducts).not.toHaveBeenCalled();
    expect(receiptService.getEntitiesForReceipts).not.toHaveBeenCalled();
    expect(receiptService.countEntitiesForReceipts).not.toHaveBeenCalled();
  });

  // The SQL orders receipts by COALESCE(purchased_at, updated_at); the in-memory
  // sort — which also mints the cursor — has to read the same thing, or a page
  // boundary lands somewhere the next query does not resume from.
  it('orders receipts by their purchase date, falling back to the row time', async () => {
    const { resolver, receiptService, entityResolutionService } = makeResolver();
    receiptService.getEntitiesForReceipts.mockResolvedValue([
      { type: 'receipt', id: 'old-purchase' },
      { type: 'receipt', id: 'undated' },
    ]);
    entityResolutionService.resolve.mockResolvedValue(
      resolveMap([
        {
          type: 'receipt',
          id: 'old-purchase',
          // Bought long ago, imported today: the purchase date is the truth.
          entity: { purchasedAt: new Date('2020-01-01'), updatedAt: new Date('2026-08-19') },
        },
        {
          type: 'receipt',
          id: 'undated',
          entity: { purchasedAt: null, updatedAt: new Date('2026-08-18') },
        },
      ]),
    );

    const result = await resolver.search(ctx, { includeTypes: ['receipt'] } as SearchInput);

    expect(nodeIds(result)).toEqual(['receipt:undated', 'receipt:old-purchase']);
  });
});

/**
 * The How filter (`connectors`) spans every kind that records a source. It
 * used to be folded into the event-only who / where filter, so picking a
 * source made the whole browse events-only — and an account whose reddit
 * import produced communications and content but no events got nothing.
 */
describe('SearchResolver.search — the How filter narrows every sourced kind', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pushes the source down to each sourced table on the timed browse and leaves the rest unfetched', async () => {
    const {
      resolver,
      eventService,
      communicationService,
      contentService,
      browserActivityService,
      noteService,
      fileService,
      personService,
    } = makeResolver();

    await resolver.search(ctx, { connectors: ['reddit'] } as SearchInput);

    const withSource = expect.objectContaining({ connectors: ['reddit'] });

    expect(eventService.getEntitiesForEvents).toHaveBeenCalledWith(ctx, withSource);
    expect(communicationService.getEntitiesForCommunications).toHaveBeenCalledWith(ctx, withSource);
    expect(contentService.getEntitiesForContents).toHaveBeenCalledWith(ctx, withSource);
    expect(browserActivityService.getEntitiesForBrowserActivities).toHaveBeenCalledWith(ctx, withSource);
    expect(communicationService.countEntitiesForCommunications).toHaveBeenCalledWith(ctx, withSource);
    expect(contentService.countEntitiesForContents).toHaveBeenCalledWith(ctx, withSource);

    // No source column to match on: not asked for, not counted.
    expect(noteService.getEntitiesForNotes).not.toHaveBeenCalled();
    expect(fileService.getEntitiesForFiles).not.toHaveBeenCalled();
    expect(personService.getEntitiesForPeople).not.toHaveBeenCalled();
    expect(noteService.countEntitiesForNotes).not.toHaveBeenCalled();
  });

  it('keeps the query path to rows from the chosen source, without collapsing it to events', async () => {
    const { resolver, searchService, entityResolutionService, eventService } = makeResolver();
    searchService.search.mockResolvedValue([
      { type: 'content', id: 'c1' },
      { type: 'note', id: 'n1' },
      { type: 'event', id: 'e1' },
      { type: 'browser-activity', id: 'b1' },
    ] as Identifier[]);
    entityResolutionService.resolve.mockResolvedValue(
      resolveMap([
        { type: 'content', id: 'c1', entity: { sourceSystem: 'reddit', updatedAt: new Date('2026-09-01') } },
        { type: 'note', id: 'n1', entity: { updatedAt: new Date('2026-09-02') } },
        { type: 'event', id: 'e1', entity: { sourceSystem: 'gmail', startTime: new Date('2026-09-03') } },
        // Browser activity keeps the column's snake_case name on its entity.
        {
          type: 'browser-activity',
          id: 'b1',
          entity: { source_system: 'reddit', time: new Date('2026-09-04') },
        },
      ]),
    );

    const result = await resolver.search(ctx, { query: 'shells', connectors: ['reddit'] } as SearchInput);

    // Relevance order, i.e. the candidate order the search returned them in.
    expect(nodeIds(result)).toEqual(['content:c1', 'browser-activity:b1']);
    // The event-only who / where restriction must not have been triggered.
    expect(eventService.getEntitiesForEvents).not.toHaveBeenCalled();
  });
});
