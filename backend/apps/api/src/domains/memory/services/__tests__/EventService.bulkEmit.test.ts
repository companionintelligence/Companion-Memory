import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { bulkInsertIdempotent } from '@ci/common/persistence';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import type { CreateEventDto } from '../../types';
import { EventService } from '../EventService';

jest.mock('@ci/common/persistence', () => ({
  ...jest.requireActual('@ci/common/persistence'),
  bulkInsertIdempotent: jest.fn(),
}));

const bulkInsertMock = bulkInsertIdempotent as jest.Mock;

/**
 * Regression guard for the bulk-ingest event-emission contract: createMany()
 * must NOT emit a per-row EventCreatedEvent (the pgboss fan-out that dominated
 * import cost) — search indexing for bulk loads is deferred to the post-load
 * sweep (POST /api/maintenance/search-index/backfill). The interactive create()
 * emission is covered by EventService.test.ts; this file pins the bulk side.
 */
describe('EventService.createMany — no per-row event emission', () => {
  let service: EventService;
  let signalling: { send: jest.Mock; sendMany: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    jest.clearAllMocks();
    bulkInsertMock.mockImplementation(async ({ entities }: { entities: EventEntity[] }) =>
      entities.map((entity) => ({ entity, inserted: true })),
    );

    const baseInsertQb: Record<string, unknown> = {};
    baseInsertQb.insert = jest.fn(() => baseInsertQb);
    baseInsertQb.into = jest.fn(() => baseInsertQb);
    baseInsertQb.values = jest.fn(() => baseInsertQb);
    baseInsertQb.onConflict = jest.fn(() => baseInsertQb);
    baseInsertQb.execute = jest.fn(async () => ({ raw: [] }));

    const baseRepo = {
      create: jest.fn((x: Partial<EventBaseEntity>) => x),
      find: jest.fn(async () => []),
      metadata: { target: EventBaseEntity, columns: { length: 10 } },
      createQueryBuilder: jest.fn(() => baseInsertQb),
    };
    const repo: Record<string, unknown> = {
      create: jest.fn((x: Partial<EventEntity>) => x as EventEntity),
    };
    // The bulk path runs inside a spanning transaction whose manager dispatches
    // by entity class.
    repo.manager = {
      transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
        cb({
          getRepository: (cls: unknown): unknown => (cls === EventBaseEntity ? baseRepo : repo),
          withRepository: (): unknown => repo,
        }),
      ),
    };
    signalling = { send: jest.fn(), sendMany: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: getRepositoryToken(EventBaseEntity), useValue: baseRepo },
        { provide: SignallingEventService, useValue: signalling },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(EventService);
  });

  it('bulk-inserts the rows but emits no EventCreatedEvent', async () => {
    const dtos: CreateEventDto[] = [
      {
        title: 'a',
        start_time: new Date('2026-01-01T00:00:00Z'),
        source_type: 'ci-import-tools',
        source_system: 'gmail',
        source_id: 'gmail:1',
      },
      {
        title: 'b',
        start_time: new Date('2026-01-02T00:00:00Z'),
        source_type: 'ci-import-tools',
        source_system: 'gmail',
        source_id: 'gmail:2',
      },
    ] as CreateEventDto[];

    // The array overload of create() IS the bulk path (routes to createManyBatched).
    const result = await service.create(ctx, dtos);

    expect(bulkInsertMock).toHaveBeenCalledTimes(1);
    expect(bulkInsertMock.mock.calls[0][0].entities).toHaveLength(2);
    expect(result).toHaveLength(2);
    // The contract under guard: NO per-row signalling from the bulk path.
    expect(signalling.send).not.toHaveBeenCalled();
    expect(signalling.sendMany).not.toHaveBeenCalled();
  });
});
