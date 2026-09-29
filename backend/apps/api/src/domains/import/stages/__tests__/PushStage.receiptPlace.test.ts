import {
  DatabaseCrashedError,
  DatabaseNotReadyError,
  isDatabaseCrashError,
  isDatabaseNotReadyError,
} from '@ci/common/persistence';

import type { StagedItem } from '../../entities/StagedItemEntity';
import { toCanonical, type CanonicalRecord } from '../../push/canonical';
import { PushStage, throwIfIngestFoundDatabaseAway } from '../PushStage';

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

/**
 * A graph double that resolves nothing and reports `message` against every
 * entity it was given — `GraphIngestService.upsertEntities`' own shape for a
 * batch-level failure: it catches, and returns `entity <key>: <message>` as
 * data rather than throwing.
 */
function graphReporting(message: string): IngestMock {
  return jest.fn(async (_ctx: { userId: string }, input: IngestInput) => ({
    entities: [],
    errors: input.entities.map((e) => `entity ${e.key}: ${message}`),
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

  describe('a database that was away, reported by ingest as text', () => {
    // `GraphIngestService` catches a batch-level failure — a crash included —
    // and returns it per entity as `entity <key>: <message>`. Reading only
    // `result.entities` turned a crash into "no place", and the receipt write
    // that followed met the recovering server and got the whole group resent.
    const stated = [
      {
        record: recordFor({ Merchant: 'Apple', Address: '1 Infinite Loop, Cupertino' }),
        participants: new Map(),
      },
    ];

    it.each([
      ['pg with no code at all', 'Connection terminated unexpectedly'],
      ['57P01 admin shutdown', 'terminating connection due to administrator command'],
      ['57P02 crash shutdown', 'terminating connection because of crash of another server process'],
      ['a reset socket', 'read ECONNRESET'],
      ['a broken pipe', 'write EPIPE'],
    ])('raises a crash after %s, so the group is never resent', async (_label, message) => {
      const ingest = graphReporting(message);
      const failure = await stageWith(ingest)
        .receiptPlacesFor({ userId: 'u1' }, stated)
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DatabaseCrashedError);
      expect(isDatabaseCrashError(failure)).toBe(true);
      expect((failure as DatabaseCrashedError).operation).toBe('resolving 1 receipt place(s)');
      // The MESSAGE half is what is carried: the key is data, not a symptom.
      expect(((failure as DatabaseCrashedError).cause as Error).message).toBe(message);
      expect(ingest).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['recovery mode', 'the database system is in recovery mode'],
      ['not yet accepting connections', 'the database system is not yet accepting connections'],
      ['too many clients', 'sorry, too many clients already'],
      ['a refused socket', 'connect ECONNREFUSED 172.18.0.2:5432'],
      ['a pool connect timeout', 'timeout exceeded when trying to connect'],
    ])('raises not-ready after %s, so the group is waited out and sent again', async (_label, message) => {
      const failure = await stageWith(graphReporting(message))
        .receiptPlacesFor({ userId: 'u1' }, stated)
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DatabaseNotReadyError);
      expect(isDatabaseNotReadyError(failure)).toBe(true);
      expect((failure as Error).message).toBe(message);
    });

    it('raises the crash when one batch reported both moments', async () => {
      const ingest = jest.fn(async (_ctx: { userId: string }, input: IngestInput) => ({
        entities: [],
        errors: [
          `entity ${input.entities[0].key}: the database system is in recovery mode`,
          `entity ${input.entities[1].key}: Connection terminated unexpectedly`,
        ],
      })) as IngestMock;

      const failure = await stageWith(ingest)
        .receiptPlacesFor({ userId: 'u1' }, [
          { record: recordFor({ Merchant: 'A', Place: 'North Shop' }), participants: new Map() },
          { record: recordFor({ Merchant: 'B', Place: 'South Shop' }), participants: new Map() },
        ])
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DatabaseCrashedError);
    });

    it('raises even when some places did resolve before the server went away', async () => {
      const ingest = jest.fn(async (_ctx: { userId: string }, input: IngestInput) => ({
        entities: [{ key: input.entities[0].key, entityId: 'entity-place-9' }],
        errors: [`entity ${input.entities[1].key}: Connection terminated unexpectedly`],
      })) as IngestMock;

      await expect(
        stageWith(ingest).receiptPlacesFor({ userId: 'u1' }, [
          { record: recordFor({ Merchant: 'A', Place: 'North Shop' }), participants: new Map() },
          { record: recordFor({ Merchant: 'B', Place: 'South Shop' }), participants: new Map() },
        ]),
      ).rejects.toBeInstanceOf(DatabaseCrashedError);
    });

    it('stays fail-soft for a refusal about the place itself: the receipt gets no place', async () => {
      const ingest = graphReporting('value too long for type character varying(255)');
      const links = await stageWith(ingest).receiptPlacesFor({ userId: 'u1' }, stated);

      expect(links).toEqual([{}]);
      expect(ingest).toHaveBeenCalledTimes(1);
    });

    it('stays fail-soft for an unresolved id, which is not the database at all', async () => {
      const links = await stageWith(
        graphReporting('could not resolve entity id after upsert'),
      ).receiptPlacesFor({ userId: 'u1' }, stated);

      expect(links).toEqual([{}]);
    });

    it('reads only the message half, never the key, when deciding the database was away', async () => {
      // The key is the place's own name — data. A venue whose name is a
      // not-ready message must not turn a plain refusal into an outage.
      const name = 'the database system is in recovery mode diner';
      const ingest = graphReporting('value too long for type character varying(255)');
      const links = await stageWith(ingest).receiptPlacesFor({ userId: 'u1' }, [
        { record: recordFor({ Merchant: 'Diner', Place: name }), participants: new Map() },
      ]);

      expect(ingest.mock.calls[0]?.[1].entities[0].key).toBe(`place:${name}`);
      expect(links).toEqual([{}]);
    });

    it('splits at the right `: ` when the place name contains one', async () => {
      const name = 'Suite 5: Main St';
      const ingest = graphReporting('Connection terminated unexpectedly');

      await expect(
        stageWith(ingest).receiptPlacesFor({ userId: 'u1' }, [
          { record: recordFor({ Merchant: 'Shop', Address: name }), participants: new Map() },
        ]),
      ).rejects.toBeInstanceOf(DatabaseCrashedError);
      expect(ingest.mock.calls[0]?.[1].entities[0].key).toBe('place:suite 5: main st');
    });

    it('is quiet for a clean ingest', () => {
      expect(() =>
        throwIfIngestFoundDatabaseAway('resolving 1 receipt place(s)', [], new Set(['place:x'])),
      ).not.toThrow();
    });
  });
});
