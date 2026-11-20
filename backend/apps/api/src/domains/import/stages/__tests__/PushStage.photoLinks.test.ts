import type { CreateEventDto } from '@ci/domains/memory';

import type { StagedItem } from '../../entities/StagedItemEntity';
import type { StageRunContext } from '../../types';
import { PushStage } from '../PushStage';

/**
 * What the photo importers stage beside each photo, and what reaches Memory.
 *
 * A Google Photos or Flickr photo carries the people tagged in it (`includes`
 * edges to `person` entities) and its links to other items: the album it is in
 * (`in_collection`), its `-edited` copy (`edit`) and the clip of a motion photo
 * (`motion_photo`). All of it was staged and none of it was written: the events
 * lane never read the participants it was handed, and nothing read item-to-item
 * edges back at all.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const PHOTO = '44444444-4444-4444-8444-444444444401';
const ALBUM = '44444444-4444-4444-8444-444444444402';
const EDITED = '44444444-4444-4444-8444-444444444403';
const CLIP_NEVER_WRITTEN = '44444444-4444-4444-8444-444444444404';

function row(id: string, over: Partial<StagedItem>): StagedItem {
  return {
    id,
    runId: RUN_ID,
    userId: USER_ID,
    dataSource: 'google_photos',
    classification: 'media',
    contentHash: `hash-${id.slice(-2)}`,
    occurredAt: new Date('2026-10-24T18:30:05Z'),
    timespanEnd: null,
    latitude: null,
    longitude: null,
    filename: 'PXL_20261024_183005222.jpg',
    mediaType: 'image/jpeg',
    originalLocation: null,
    intermediateLocation: null,
    metadata: { Title: 'Haystack Rock at low tide' },
    createdAt: new Date('2026-11-20T00:00:00Z'),
    ...over,
  } as StagedItem;
}

const photo = row(PHOTO, {});
const album = row(ALBUM, {
  classification: 'collection',
  occurredAt: null,
  filename: 'Cannon Beach weekend',
  mediaType: null,
  metadata: {},
});
const edited = row(EDITED, { filename: 'PXL_20261024_183005222-edited.jpg', metadata: {} });

interface Options {
  /** What the participants lookup returns: the staged item -> entity edges, resolved. */
  participants?: Array<{ item_id: string; relation: string; server_entity_id: string; depicts: boolean }>;
  /** What the item-to-item link query returns. */
  links?: Array<{ id: string; itemId: string; relatedItemId: string; relation: string }>;
  /** Staged ids with no content row (failed, or never pushed). */
  missingContent?: string[];
  ingest?: jest.Mock;
}

function makeStage(rows: StagedItem[], options: Options = {}) {
  let servedBatch = false;
  const events: CreateEventDto[] = [];
  const contentLookups: unknown[][] = [];
  const ingest =
    options.ingest ?? jest.fn(async () => ({ entities: [], errors: [], relationshipsProcessed: 2 }));
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('pg_database_size')) {
        return [{ bytes: '1000' }];
      }

      if (sql.includes('data_directory')) {
        return [];
      }

      if (sql.trimStart().startsWith('UPDATE')) {
        return [];
      }

      if (sql.includes('related_item_id IS NOT NULL')) {
        return options.links ?? [];
      }

      if (sql.includes('staged_relationships')) {
        return options.participants ?? [];
      }

      if (sql.includes('JOIN ci.content c')) {
        contentLookups.push(params);
        const stagedIds = params[1] as string[];

        return stagedIds
          .filter((id) => !(options.missingContent ?? []).includes(id))
          .map((id) => ({ staged_id: id, content_id: `content-${id.slice(-2)}` }));
      }

      if (sql.includes('id = ANY($2::uuid[])')) {
        const wanted = params[1] as string[];

        return rows.filter((r) => wanted.includes(r.id));
      }

      if (sql.includes('SELECT entity_id FROM ci.users')) {
        return [{ entity_id: null }];
      }

      if (sql.includes('trust_mode')) {
        return [{ trust_mode: 'balanced' }];
      }

      if (sql.includes('FROM ci.users u')) {
        return [];
      }

      if (sql.includes('AS unrouted') || sql.includes('DISTINCT ON (data_source)')) {
        return [];
      }

      if (sql.includes('FROM ci_import.staged_entities') && sql.includes('GROUP BY 1, 2')) {
        return [];
      }

      if (sql.includes("'item' AS kind")) {
        return [];
      }

      if (sql.includes('identity_key AS "identityKey"')) {
        return [];
      }

      if (sql.includes('count(*)')) {
        return [{ count: String(rows.length) }];
      }

      if (sql.includes('media_type AS "mediaType"')) {
        if (servedBatch) {
          return [];
        }

        servedBatch = true;

        return rows;
      }

      throw new Error(`unexpected query: ${sql}`);
    }),
  };

  const aligned = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ inserted: true, entity: { id: `${prefix}-${i}` } }));

  const stage = new PushStage(
    dataSource as never,
    { createManyDetailed: jest.fn(async (_c: unknown, input: unknown[]) => aligned(input.length, 'comm')) } as never,
    { createManyDetailed: jest.fn(async (_c: unknown, input: unknown[]) => aligned(input.length, 'content')) } as never,
    {
      createDetailed: jest.fn(async (_c: unknown, input: CreateEventDto[]) => {
        events.push(...input);

        return aligned(input.length, 'event');
      }),
    } as never,
    { createManyDetailed: jest.fn(async () => []) } as never,
    { upsertFromExtraction: jest.fn(async () => undefined) } as never,
    { createManyDetailed: jest.fn(async () => []) } as never,
    { createMany: jest.fn(async () => undefined) } as never,
    { upsertForSubjects: jest.fn(async () => 0) } as never,
    { create: jest.fn(async () => undefined) } as never,
    { createManyDetailed: jest.fn(async () => []) } as never,
    { ingest } as never,
    { send: jest.fn(async () => undefined) } as never,
    logger as never,
  );

  return { stage, events, ingest, contentLookups, logger };
}

const context: StageRunContext = {
  runId: RUN_ID,
  userId: USER_ID,
  stageId: '22222222-2222-4222-8222-222222222222',
  scratchDir: '/tmp/does-not-matter',
  progress: jest.fn(async () => undefined),
} as unknown as StageRunContext;

describe('the people tagged in a photo', () => {
  it('become participants of its event, and nothing else the photo includes does', async () => {
    const { stage, events } = makeStage([photo, edited], {
      participants: [
        { item_id: PHOTO, relation: 'includes', server_entity_id: 'person-1', depicts: true },
        { item_id: PHOTO, relation: 'includes', server_entity_id: 'person-2', depicts: true },
        // An `includes` edge to something that is not a person (Uber stages
        // the dishes of an order this way) stays off the event.
        { item_id: PHOTO, relation: 'includes', server_entity_id: 'dish-1', depicts: false },
      ],
    });

    await stage.run(context);

    const byTitle = new Map(events.map((event) => [event.title, event]));
    expect(byTitle.get('Haystack Rock at low tide')?.participant_entity_ids).toEqual(['person-1', 'person-2']);
    expect(events.filter((event) => event.participant_entity_ids)).toHaveLength(1);
  });
});

describe('links between staged items', () => {
  const links = [
    { id: '55555555-5555-4555-8555-555555555501', itemId: PHOTO, relatedItemId: ALBUM, relation: 'in_collection' },
    { id: '55555555-5555-4555-8555-555555555502', itemId: PHOTO, relatedItemId: EDITED, relation: 'edit' },
    {
      id: '55555555-5555-4555-8555-555555555503',
      itemId: PHOTO,
      relatedItemId: CLIP_NEVER_WRITTEN,
      relation: 'motion_photo',
    },
  ];

  it('are written as graph edges between the content rows the items became', async () => {
    const { stage, ingest, contentLookups } = makeStage([photo, album, edited], { links });

    const outcome = await stage.run(context);

    // Each end is looked up by the identity its content row was written under.
    expect(contentLookups).toHaveLength(1);
    expect(contentLookups[0][1]).toEqual(expect.arrayContaining([PHOTO, ALBUM, EDITED]));

    const edges = ingest.mock.calls.flatMap(([, input]) => input.relationships);
    expect(edges).toEqual([
      expect.objectContaining({
        fromEntityId: 'content-01',
        fromEntityType: 'Content',
        toEntityId: 'content-02',
        toEntityType: 'Content',
        type: 'PART_OF',
      }),
      // The copy is derived from the original, the reverse of the staged edge.
      expect.objectContaining({ fromEntityId: 'content-03', toEntityId: 'content-01', type: 'DERIVED_FROM' }),
    ]);
    // The clip was never staged as a row with content, so its link is left out.
    expect(edges).toHaveLength(2);
    expect(outcome.detail).toEqual(expect.objectContaining({ itemLinks: 2 }));
  });

  it('leave out a link whose other end has no content row', async () => {
    const { stage, ingest } = makeStage([photo, album, edited], { links, missingContent: [ALBUM] });

    await stage.run(context);

    const edges = ingest.mock.calls.flatMap(([, input]) => input.relationships);
    expect(edges).toEqual([expect.objectContaining({ type: 'DERIVED_FROM' })]);
  });

  it('do not fail the import when the edge write fails', async () => {
    const ingest = jest.fn(async () => {
      throw new Error('relationship write refused');
    });
    const { stage, logger } = makeStage([photo, album, edited], { links, ingest });

    const outcome = await stage.run(context);

    expect(outcome.detail).not.toHaveProperty('itemLinks');
    expect(logger.warn).toHaveBeenCalledWith(
      'Linking staged items to each other failed; importing the export again writes the links',
      expect.objectContaining({ runId: RUN_ID }),
    );
  });

  it('cost nothing on a run that staged none', async () => {
    const { stage, ingest, contentLookups } = makeStage([photo]);

    await stage.run(context);

    expect(contentLookups).toEqual([]);
    expect(ingest).not.toHaveBeenCalled();
  });
});
