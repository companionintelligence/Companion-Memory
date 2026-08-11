import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { EventService } from '../EventService';

/**
 * The CTI aggregate contract: the ci.entities base row is the SOLE owner of
 * title/description, the detail row carries only event-specific data, and the
 * service composes/routes accordingly.
 */
describe('EventService CTI aggregate', () => {
  let service: EventService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let baseRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    baseRepo = {
      create: jest.fn((x: Partial<EventBaseEntity>) => x),
      save: jest.fn(async (x: Partial<EventBaseEntity>) => x),
      find: jest.fn(async () => []),
      update: jest.fn(async () => ({ affected: 1 })),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    repo = {
      findOne: jest.fn(),
      find: jest.fn(async () => []),
      create: jest.fn((x: Partial<EventEntity>) => x),
      save: jest.fn(async (x: Partial<EventEntity>) => ({ ...x, id: x.id ?? 'e1' })),
      update: jest.fn(async () => ({ affected: 1 })),
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown => (cls === EventBaseEntity ? baseRepo : repo),
          }),
        ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: getRepositoryToken(EventBaseEntity), useValue: baseRepo },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(EventService);
  });

  it('create writes the base row (owner of title/description) and the detail with the SAME uuid', async () => {
    repo.findOne.mockResolvedValue(null);

    const [event] = await service.create(ctx, {
      id: 'e1',
      title: 'Dinner',
      description: 'with Dana',
      start_time: new Date('2026-01-01T00:00:00Z'),
    });

    expect(baseRepo.save).toHaveBeenCalledTimes(1);
    expect(baseRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'e1',
      name: 'Dinner',
      description: 'with Dana',
      userId: 'user-1',
      linkedTable: 'events',
      linkedId: 'e1',
    });

    // The detail row carries no title/description (normalized away).
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save.mock.calls[0][0]).not.toHaveProperty('title');

    // Egress composes the pair.
    expect(event.title).toBe('Dinner');
    expect(event.description).toBe('with Dana');
  });

  it('findById composes title/description from the base row', async () => {
    repo.findOne.mockResolvedValue(Object.assign(new EventEntity(), { id: 'e1', userId: 'user-1' }));
    baseRepo.find.mockResolvedValue([
      Object.assign(new EventBaseEntity(), { id: 'e1', name: 'Dinner', description: null }),
    ]);

    const event = await service.findById({ userId: 'user-1' } as ServiceContext, 'e1');

    expect(baseRepo.find).toHaveBeenCalledTimes(1);
    expect(event?.title).toBe('Dinner');
  });

  it('update routes title/description to the base row and detail fields to the detail row', async () => {
    const row = Object.assign(new EventEntity(), { id: 'e1', userId: 'user-1' });
    repo.findOne.mockResolvedValue(row);
    baseRepo.find.mockResolvedValue([
      Object.assign(new EventBaseEntity(), { id: 'e1', name: 'Renamed', description: null }),
    ]);

    const result = await service.update({ userId: 'user-1' } as ServiceContext, 'e1', {
      title: 'Renamed',
      category: 'social',
    });

    expect(baseRepo.update).toHaveBeenCalledWith({ id: 'e1' }, { name: 'Renamed' });
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith({ id: 'e1' }, expect.objectContaining({ category: 'social' }));
    expect(repo.update.mock.calls[0][1]).not.toHaveProperty('title');
    expect(result?.title).toBe('Renamed');
  });

  it('remove deletes via the BASE row (FK cascades the detail)', async () => {
    repo.findOne.mockResolvedValueOnce(Object.assign(new EventEntity(), { id: 'e1', userId: 'user-1' }));

    const removed = await service.remove({ userId: 'user-1' } as ServiceContext, 'e1');

    expect(removed).toBe(true);
    expect(baseRepo.delete).toHaveBeenCalledWith({ id: 'e1' });
  });
});
