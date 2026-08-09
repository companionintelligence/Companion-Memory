import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import type { CreateEventDto } from '../../types';
import { EventService } from '../EventService';

describe('EventService.create — source idempotency', () => {
  let service: EventService;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let baseRepo: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let signalling: { send: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;
  const dto = (): CreateEventDto =>
    ({
      title: 'Action required: your billing account was suspended',
      start_time: new Date('2026-01-01T00:00:00Z'),
      source_type: 'ci-import-tools',
      source_system: 'gmail',
      source_id: 'gmail:abc-123',
    }) as CreateEventDto;

  beforeEach(async () => {
    baseRepo = {
      create: jest.fn((x: Partial<EventBaseEntity>) => x),
      save: jest.fn(async (x: Partial<EventBaseEntity>) => x),
      find: jest.fn(async () => []),
    };
    repo = {
      findOne: jest.fn(),
      create: jest.fn((x: Partial<EventEntity>) => x),
      save: jest.fn(async (x: Partial<EventEntity>) => ({ ...x, id: x.id ?? 'inserted-id' })),
      // Writes run in a transaction; the manager dispatches by entity class.
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown => (cls === EventBaseEntity ? baseRepo : repo),
          }),
        ),
      },
    };
    signalling = { send: jest.fn() };

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

  it('persists source_id and inserts when the provenance triple is new', async () => {
    repo.findOne.mockResolvedValue(null);

    await service.create(ctx, dto());

    expect(repo.findOne).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save.mock.calls[0][0].sourceId).toBe('gmail:abc-123');
    expect(signalling.send).toHaveBeenCalledTimes(1); // EventCreatedEvent fires for new rows
  });

  it('is idempotent: an existing triple returns the existing row without inserting or signalling', async () => {
    repo.findOne.mockResolvedValue({ id: 'existing-id', sourceId: 'gmail:abc-123' });

    const [result] = await service.create(ctx, dto());

    expect(result.id).toBe('existing-id');
    expect(repo.save).not.toHaveBeenCalled();
    expect(signalling.send).not.toHaveBeenCalled(); // no duplicate, no re-derivation
  });

  it('without a source_id, always inserts (no idempotency lookup)', async () => {
    await service.create(ctx, {
      title: 'manual note',
      start_time: new Date(),
      source_type: 'manual',
    } as CreateEventDto);

    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('recovers from a unique-violation race (23505) by returning the winning row', async () => {
    repo.findOne
      .mockResolvedValueOnce(null) // pre-check: not there yet
      .mockResolvedValueOnce({ id: 'race-winner', sourceId: 'gmail:abc-123' }); // post-conflict re-fetch
    repo.save.mockRejectedValueOnce({ code: '23505' });

    const [result] = await service.create(ctx, dto());

    expect(result.id).toBe('race-winner');
    expect(signalling.send).not.toHaveBeenCalled();
  });

  it('matches the triple scoped to the requesting user', async () => {
    repo.findOne.mockResolvedValue(null);

    await service.create(ctx, dto());

    const where = repo.findOne.mock.calls[0][0].where;
    expect(where).toMatchObject({
      sourceType: 'ci-import-tools',
      sourceSystem: 'gmail',
      sourceId: 'gmail:abc-123',
      user: { id: 'user-1' },
    });
  });
});
