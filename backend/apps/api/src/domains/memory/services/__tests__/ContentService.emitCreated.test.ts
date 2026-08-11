import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { bulkInsertIdempotent } from '@ci/common/persistence';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { ContentCreatedEvent } from '@ci/domains/memory/events';

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

/**
 * Regression guard for the bulk-ingest event-emission contract:
 *  - the interactive single create() (ETL transforms, per-row) emits
 *    ContentCreatedEvent for live search indexing;
 *  - the bulk createMany() path suppresses per-row emission by default —
 *    indexing for bulk loads is recovered by the post-load sweep
 *    (POST /api/maintenance/search-index/backfill), avoiding the pgboss fan-out
 *    that dominated import cost;
 *  - createMany() with { emitCreated: true } (the single createContent GraphQL
 *    mutation) emits, but ONLY for rows this call genuinely inserted — a dedup
 *    re-send stays a no-op.
 * If someone re-enables per-row emission in the default bulk path, or drops
 * emission from the interactive path, this fails.
 */
describe('ContentService — ContentCreatedEvent emission contract', () => {
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
    metadata: { columns: unknown[] };
    createQueryBuilder: jest.Mock;
  };
  let eventRepo: { createQueryBuilder: jest.Mock };
  let signalling: { send: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default: every built entity is reported inserted, in input order.
    bulkInsertMock.mockImplementation(async ({ entities }: { entities: ContentEntity[] }) =>
      entities.map((entity) => ({ entity, inserted: true })),
    );

    const baseInsert = {} as { values?: unknown[]; conflict?: string };
    baseRepo = {
      create: jest.fn((x: Partial<ContentBaseEntity>) => x),
      save: jest.fn(async (x: Partial<ContentBaseEntity>) => x),
      find: jest.fn(async () => []),
      metadata: { columns: Array.from({ length: 10 }) },
      createQueryBuilder: jest.fn(() => makeInsertBuilder(baseInsert)),
    };
    repo = {
      create: jest.fn((x: { id?: string }) => x),
      save: jest.fn(async (x: { id?: string }) => ({ ...x, id: x.id ?? 'content-1' })),
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown => (cls === ContentBaseEntity ? baseRepo : repo),
          }),
        ),
      },
    };
    // No event auto-link in these tests — the query returns nothing.
    eventRepo = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };
    signalling = { send: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
        { provide: getRepositoryToken(ContentBaseEntity), useValue: baseRepo },
        { provide: getRepositoryToken(EventEntity), useValue: eventRepo },
        { provide: SignallingEventService, useValue: signalling },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    }).compile();
    service = mod.get(ContentService);
  });

  it('interactive create() emits ContentCreatedEvent for the new row', async () => {
    await service.create(ctx, { type: 'note', text: 'hi' } as CreateContentDto);

    expect(signalling.send).toHaveBeenCalledTimes(1);
    // create() assigns a uuidv7 before save, so assert the event name + shape.
    expect(signalling.send).toHaveBeenCalledWith(ContentCreatedEvent, { contentId: expect.any(String) });
  });

  it('create() with emitCreated:false suppresses the event', async () => {
    await service.create(ctx, { type: 'note', text: 'hi' } as CreateContentDto, { emitCreated: false });

    expect(signalling.send).not.toHaveBeenCalled();
  });

  it('bulk createMany() (default) never emits per-row events — indexing is deferred to the backfill sweep', async () => {
    await service.createMany(ctx, [
      { type: 'note', text: 'a', source_type: 'ci-import-tools', source_system: 'x', source_id: '1' },
      { type: 'note', text: 'b', source_type: 'ci-import-tools', source_system: 'x', source_id: '2' },
    ] as CreateContentDto[]);

    // One set-based insert for the whole batch…
    expect(bulkInsertMock).toHaveBeenCalledTimes(1);
    expect(bulkInsertMock.mock.calls[0][0].entities).toHaveLength(2);
    // …and no per-row fan-out.
    expect(signalling.send).not.toHaveBeenCalled();
  });

  it('createMany({ emitCreated: true }) emits once per genuinely-inserted row', async () => {
    // The single createContent GraphQL mutation asks for live indexing.
    await service.createMany(
      ctx,
      [
        { type: 'note', text: 'live', source_type: 'ci-import-tools', source_system: 'x', source_id: '7' },
      ] as CreateContentDto[],
      { emitCreated: true },
    );

    expect(signalling.send).toHaveBeenCalledTimes(1);
    expect(signalling.send).toHaveBeenCalledWith(ContentCreatedEvent, { contentId: expect.any(String) });
  });

  it('createMany({ emitCreated: true }) does NOT emit for a deduped re-send (found, not inserted)', async () => {
    // bulkInsertIdempotent found the existing row: inserted=false.
    bulkInsertMock.mockResolvedValueOnce([
      { entity: { id: 'content-existing' } as ContentEntity, inserted: false },
    ]);

    await service.createMany(
      ctx,
      [
        { type: 'note', text: 'dupe', source_type: 'ci-import-tools', source_system: 'x', source_id: '7' },
      ] as CreateContentDto[],
      { emitCreated: true },
    );

    // Re-send of an existing triple must not re-index.
    expect(signalling.send).not.toHaveBeenCalled();
  });
});
