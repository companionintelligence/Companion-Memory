import type { StagedItem } from '../../entities/StagedItemEntity';
import { toCanonical, type CanonicalRecord } from '../../push/canonical';
import { PushStage } from '../PushStage';

/*
 * WHERE an imported receipt happened.
 *
 * `ci.receipts.place_entity_id` is the "known place" half of object
 * identification (`ObjectResolutionService`'s `place_prior` rung) and the only
 * thing that puts a purchase on the map. No import path wrote it: the receipt
 * mapper never saw a graph id, and nothing resolved one for it.
 *
 * Two ways a record can state a place, and both must land on ONE node.
 */

const noop = {} as never;

/** What the stage asks the graph for, and what it gets back. */
interface IngestInput {
  entities: Array<{ key: string; entityType: string; name: string; sourceSystem: string }>;
  relationships: unknown[];
}
type IngestResult = { entities: Array<{ key: string; entityId: string }>; errors: string[] };
type IngestMock = jest.Mock<Promise<IngestResult>, [{ userId: string }, IngestInput]>;

/** A graph double that resolves the given keys and nothing else. */
function graphResolving(byKey: Record<string, string>): IngestMock {
  return jest.fn(async (_ctx: { userId: string }, input: IngestInput) => ({
    entities: input.entities.flatMap((e) => (byKey[e.key] ? [{ key: e.key, entityId: byKey[e.key] }] : [])),
    errors: [],
  }));
}

interface PlaceResolver {
  receiptPlacesFor(
    ctx: { userId: string },
    rows: ReadonlyArray<{ record: CanonicalRecord; participants: Map<string, string[]> }>,
  ): Promise<Array<{ placeEntityId?: string }>>;
}

function stageWith(ingest: IngestMock): PlaceResolver {
  const stage = new PushStage(
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    { ingest } as never,
    noop,
    { setContext: jest.fn() } as never,
  );

  return stage as unknown as PlaceResolver;
}

function recordFor(metadata: Record<string, unknown>): CanonicalRecord {
  return toCanonical({
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    dataSource: 'gmail',
    classification: 'receipt',
    contentHash: 'hash-1',
    occurredAt: new Date('2024-03-02T10:00:00Z'),
    timespanEnd: null,
    latitude: null,
    longitude: null,
    filename: null,
    mediaType: null,
    originalLocation: null,
    intermediateLocation: null,
    metadata,
    createdAt: new Date('2026-08-12T00:00:00Z'),
  } as StagedItem);
}

describe('PushStage receipt places', () => {
  it('takes a place the parser already staged, through the entity mappings', async () => {
    // The same join `resolveCorrespondents` reads a message's from/to through:
    // the parser staged the place, `pushEntities` resolved it, and the edge is
    // already a server entity id by the time the record is sent.
    const ingest = graphResolving({});
    const links = await stageWith(ingest).receiptPlacesFor({ userId: 'u1' }, [
      {
        record: recordFor({ Merchant: 'Blue Bottle', Total: '4.50', Currency: 'USD' }),
        participants: new Map([['place', ['entity-place-1']]]),
      },
    ]);

    expect(links).toEqual([{ placeEntityId: 'entity-place-1' }]);
    // A staged edge is already resolved; asking the graph again would be a
    // round trip to be told what we were handed.
    expect(ingest).not.toHaveBeenCalled();
  });

  it('resolves a stated address under the key a staged place would have taken', async () => {
    // A record that only NAMES a place in its metadata and a parser that staged
    // the same place must be ONE node. That is only true if both go in under
    // the same natural key — `place:<lowercased name>` (push/entities.ts
    // naturalKeyFor / placeKeyFor).
    const ingest = graphResolving({ 'place:1 infinite loop, cupertino': 'entity-place-2' });
    const links = await stageWith(ingest).receiptPlacesFor({ userId: 'u1' }, [
      {
        record: recordFor({ Merchant: 'Apple', Address: '1 Infinite Loop, Cupertino' }),
        participants: new Map(),
      },
    ]);

    expect(links).toEqual([{ placeEntityId: 'entity-place-2' }]);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[1]).toEqual({
      entities: [
        {
          key: 'place:1 infinite loop, cupertino',
          entityType: 'Location',
          name: '1 Infinite Loop, Cupertino',
          sourceSystem: 'gmail',
        },
      ],
      relationships: [],
    });
  });

  it('ingests one entity for a name a whole batch shares, and none when nothing names a place', async () => {
    const ingest = graphResolving({ 'place:corner shop': 'entity-place-3' });
    const stage = stageWith(ingest);

    const shared = await stage.receiptPlacesFor({ userId: 'u1' }, [
      { record: recordFor({ Merchant: 'Corner Shop', Venue: 'Corner Shop' }), participants: new Map() },
      { record: recordFor({ Merchant: 'Corner Shop', Venue: 'corner shop' }), participants: new Map() },
    ]);

    expect(shared).toEqual([{ placeEntityId: 'entity-place-3' }, { placeEntityId: 'entity-place-3' }]);
    expect(ingest.mock.calls[0]?.[1].entities).toHaveLength(1);

    ingest.mockClear();

    // The common case today: no commerce parser states an address, so the
    // batch must cost NOTHING rather than a round trip per push.
    const none = await stage.receiptPlacesFor({ userId: 'u1' }, [
      { record: recordFor({ Merchant: 'Amazon', Total: '19.99' }), participants: new Map() },
    ]);

    expect(none).toEqual([{}]);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('writes no place when the graph could not resolve the name', async () => {
    // A place that will not resolve costs the receipt its place, never its
    // import.
    const ingest = graphResolving({});
    const links = await stageWith(ingest).receiptPlacesFor({ userId: 'u1' }, [
      { record: recordFor({ Merchant: 'Apple', Place: 'Regent Street' }), participants: new Map() },
    ]);

    expect(links).toEqual([{}]);
  });
});
