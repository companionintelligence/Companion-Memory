import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { bulkInsertIdempotent } from '@ci/common/persistence';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventEntity } from '../../entities/EventEntity';
import type { CreateContentDto } from '../../types';
import { ContentService } from '../ContentService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { makeInsertBuilder } from './harness/insertBuilder';
import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

jest.mock('@ci/common/persistence', () => ({
  ...jest.requireActual('@ci/common/persistence'),
  bulkInsertIdempotent: jest.fn(),
}));

const bulkInsertMock = bulkInsertIdempotent as jest.Mock;

describe('ContentService.create — event link (single, per-row path)', () => {
  let service: ContentService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let baseRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let eventRepo: { createQueryBuilder: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    jest.clearAllMocks();
    baseRepo = {
      create: jest.fn((x: Partial<ContentBaseEntity>) => x),
      save: jest.fn(async (x: Partial<ContentBaseEntity>) => x),
      find: jest.fn(async () => []),
    };
    repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: { id?: string }) => ({ ...x, id: x.id ?? 'content-1' })),
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown => (cls === ContentBaseEntity ? baseRepo : repo),
          }),
        ),
      },
    };
    eventRepo = { createQueryBuilder: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
        { provide: getRepositoryToken(ContentBaseEntity), useValue: baseRepo },
        { provide: getRepositoryToken(EventEntity), useValue: eventRepo },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    }).compile();
    service = mod.get(ContentService);
  });

  it('links content to its event when event is provided', async () => {
    await service.create(ctx, {
      type: 'attachment',
      mimetype: 'image/jpeg',
      url: 'https://store/abc.jpg',
      event: { id: 'event-9' },
    } as CreateContentDto);

    expect(repo.create.mock.calls[0][0]).toMatchObject({
      type: 'attachment',
      mimetype: 'image/jpeg',
      event: { id: 'event-9' },
      userId: 'user-1',
    });
  });

  it('omits the event relation when no event is given', async () => {
    await service.create(ctx, { type: 'note', text: 'hi' } as CreateContentDto);
    expect(repo.create.mock.calls[0][0].event).toBeUndefined();
  });

  // Regression: ci.content.user_id and the `user` relation map to the same DB
  // column. When the scalar was insert:false the owner was written via the
  // relation only and silently shadowed to NULL, which broke every user_id-scoped
  // read. The owner must be persisted on the scalar column and surface on egress.
  it('persists the owner on the scalar user_id column, not the relation', async () => {
    const [created] = await service.create(ctx, { type: 'note', text: 'hi' } as CreateContentDto);

    const persisted = repo.create.mock.calls[0][0];
    expect(persisted.userId).toBe('user-1');
    // The relation must NOT be the write path (it shadowed the column to NULL).
    expect(persisted.user).toBeUndefined();
    // ...and the owner round-trips through toEgressType.
    expect(created.userId).toBe('user-1');
  });
});

/**
 * WS3: ContentService.createMany is the set-based bulk path. It replaces the old
 * per-row (findOne dedup + findOne event-link + save) loop with:
 *   - ONE eventRepository query resolving the event auto-link for the whole batch
 *   - ONE bulkInsertIdempotent call (existence pre-check + INSERT..ON CONFLICT +
 *     hydrate) keyed on the provenance triple.
 * These tests pin that contract: the triple dedup is delegated to
 * bulkInsertIdempotent (arbiter matches content_source_triple_uniq), the event
 * auto-link is a single set-based lookup, and a mixed linkable/non-linkable batch
 * behaves exactly as before (only exact triple matches link; others stay null).
 */
describe('ContentService.createMany — set-based batch + event auto-link', () => {
  let service: ContentService;
  let contentRepo: {
    create: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let baseRepo: {
    create: jest.Mock;
    find: jest.Mock;
    metadata: { columns: unknown[] };
    createQueryBuilder: jest.Mock;
  };
  let eventQb: {
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getMany: jest.Mock;
  };
  let eventRepo: { createQueryBuilder: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  /** Have the (single) set-based event lookup resolve to these events. */
  const stubEventQb = (events: Partial<EventEntity>[]) => {
    eventQb.getMany.mockResolvedValue(events);
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // The bulk helper is mocked: echo each built entity back as inserted, so we
    // can assert on the entities the service handed it (id, userId, triple, event).
    bulkInsertMock.mockImplementation(async ({ entities }: { entities: ContentEntity[] }) =>
      entities.map((entity) => ({ entity, inserted: true })),
    );

    const baseInsert = {} as { values?: unknown[]; conflict?: string };
    baseRepo = {
      create: jest.fn((x: Partial<ContentBaseEntity>) => x),
      find: jest.fn(async () => []),
      metadata: { columns: Array.from({ length: 10 }) },
      createQueryBuilder: jest.fn(() => makeInsertBuilder(baseInsert)),
    };

    // contentRepository.create returns the object it is given (with the service's
    // defaults applied), so the entities array handed to bulkInsert is inspectable.
    contentRepo = {
      create: jest.fn((x: Partial<ContentEntity>) => x as ContentEntity),
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown => (cls === ContentBaseEntity ? baseRepo : contentRepo),
          }),
        ),
      },
    };

    eventQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    eventRepo = { createQueryBuilder: jest.fn(() => eventQb) };

    const mod = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: contentRepo },
        { provide: getRepositoryToken(ContentBaseEntity), useValue: baseRepo },
        { provide: getRepositoryToken(EventEntity), useValue: eventRepo },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    }).compile();
    service = mod.get(ContentService);
  });

  it('delegates triple dedup to bulkInsertIdempotent with the content arbiter', async () => {
    await service.createMany(ctx, [
      {
        type: 'Photo',
        source_type: 'import',
        source_system: 'facebook',
        source_id: 'photo-1',
      } as CreateContentDto,
    ]);

    expect(bulkInsertMock).toHaveBeenCalledTimes(1);
    const opts = bulkInsertMock.mock.calls[0][0];
    // Arbiter is the exact partial unique index (user-scoped, WHERE source_id NOT NULL).
    expect(opts.conflictTarget).toBe(
      '(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL',
    );
    expect(opts.scope).toEqual({ userId: 'user-1' });
    expect(opts.tripleColumns).toEqual(['source_type', 'source_system', 'source_id']);
    // The row carries its triple + owner for the set-based insert.
    expect(opts.entities).toHaveLength(1);
    expect(opts.getTriple(opts.entities[0])).toEqual({
      sourceType: 'import',
      sourceSystem: 'facebook',
      sourceId: 'photo-1',
    });
    expect(opts.entities[0].userId).toBe('user-1');
  });

  it('re-sending the same triple is a no-op find-or-return (the arbiter dedups)', async () => {
    // bulkInsertIdempotent absorbs the conflict and returns the existing row as
    // not-inserted; the service returns it in input order without a second insert.
    bulkInsertMock.mockResolvedValueOnce([
      { entity: { id: 'content-existing', type: 'Photo' } as ContentEntity, inserted: false },
    ]);

    const result = await service.createMany(ctx, [
      {
        type: 'Photo',
        source_type: 'import',
        source_system: 'facebook',
        source_id: 'photo-dupe',
      } as CreateContentDto,
    ]);

    expect(result[0].id).toBe('content-existing');
    // A single set-based insert — no per-row fan-out.
    expect(bulkInsertMock).toHaveBeenCalledTimes(1);
  });

  it('auto-links each row to the event sharing its triple via ONE set-based lookup', async () => {
    stubEventQb([
      { id: 'event-a', sourceType: 'import', sourceSystem: 'facebook', sourceId: 'photo-42' },
      { id: 'event-b', sourceType: 'import', sourceSystem: 'facebook', sourceId: 'photo-43' },
    ]);

    await service.createMany(ctx, [
      { type: 'Photo', source_type: 'import', source_system: 'facebook', source_id: 'photo-42' },
      { type: 'Photo', source_type: 'import', source_system: 'facebook', source_id: 'photo-43' },
    ] as CreateContentDto[]);

    // Exactly one event query for the whole batch (not one per row).
    expect(eventRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    // Scoped to the user.
    expect(eventQb.where).toHaveBeenCalledWith('event.userId = :userId', { userId: 'user-1' });

    const entities = bulkInsertMock.mock.calls[0][0].entities;
    expect(entities[0].event).toEqual({ id: 'event-a' });
    expect(entities[1].event).toEqual({ id: 'event-b' });
  });

  it('matches a NULL source_system event to a NULL-system row (IS NOT DISTINCT FROM)', async () => {
    stubEventQb([{ id: 'event-null-sys', sourceType: 'import', sourceSystem: null, sourceId: 'x-1' }]);

    await service.createMany(ctx, [
      { type: 'note', source_type: 'import', source_id: 'x-1' } as CreateContentDto,
    ]);

    const entities = bulkInsertMock.mock.calls[0][0].entities;
    expect(entities[0].event).toEqual({ id: 'event-null-sys' });
  });

  it('prefers an explicit event over the triple lookup (and skips the lookup if none need it)', async () => {
    await service.createMany(ctx, [
      {
        type: 'Photo',
        source_type: 'import',
        source_system: 'facebook',
        source_id: 'photo-7',
        event: { id: 'explicit-event' },
      } as CreateContentDto,
    ]);

    // No triple-carrying row NEEDS a lookup (the only row has an explicit event),
    // so the set-based event query is not even issued.
    expect(eventRepo.createQueryBuilder).not.toHaveBeenCalled();
    const entities = bulkInsertMock.mock.calls[0][0].entities;
    expect(entities[0].event).toEqual({ id: 'explicit-event' });
  });

  it('leaves event undefined when nothing matches the triple', async () => {
    stubEventQb([]); // no event shares the triple

    await service.createMany(ctx, [
      { type: 'Photo', source_type: 'import', source_system: 'facebook', source_id: 'photo-none' },
    ] as CreateContentDto[]);

    const entities = bulkInsertMock.mock.calls[0][0].entities;
    expect(entities[0].event).toBeUndefined();
  });

  it('a mixed batch links only exact triple matches, leaving the rest null — as before', async () => {
    // Only 'photo-1' has a matching event. 'photo-2' has a triple but no event.
    // The third row has NO triple (never links, never dedups).
    stubEventQb([{ id: 'event-1', sourceType: 'import', sourceSystem: 'facebook', sourceId: 'photo-1' }]);

    await service.createMany(ctx, [
      { type: 'Photo', source_type: 'import', source_system: 'facebook', source_id: 'photo-1' },
      { type: 'Photo', source_type: 'import', source_system: 'facebook', source_id: 'photo-2' },
      { type: 'note', text: 'no triple' },
    ] as CreateContentDto[]);

    const entities = bulkInsertMock.mock.calls[0][0].entities;
    expect(entities).toHaveLength(3);
    expect(entities[0].event).toEqual({ id: 'event-1' }); // linked
    expect(entities[1].event).toBeUndefined(); // triple, no match → null
    expect(entities[2].event).toBeUndefined(); // no triple → null
    // Every row is owned by the requesting user.
    expect(entities.every((e: ContentEntity) => e.userId === 'user-1')).toBe(true);
  });

  it('stamps the owner on each bulk-ingested row and returns rows in input order', async () => {
    bulkInsertMock.mockImplementationOnce(async ({ entities }: { entities: ContentEntity[] }) =>
      entities.map((entity) => ({ entity: { ...entity }, inserted: true })),
    );

    const result = await service.createMany(ctx, [
      { type: 'Photo', source_type: 'import', source_system: 'facebook', source_id: 'a' },
      { type: 'Photo', source_type: 'import', source_system: 'facebook', source_id: 'b' },
    ] as CreateContentDto[]);

    expect(result).toHaveLength(2);
    expect(result[0].sourceId).toBe('a');
    expect(result[1].sourceId).toBe('b');
    expect(result.every((r) => r.userId === 'user-1')).toBe(true);
  });

  it('returns [] for an empty batch without touching the DB', async () => {
    const result = await service.createMany(ctx, []);
    expect(result).toEqual([]);
    expect(bulkInsertMock).not.toHaveBeenCalled();
    expect(eventRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
