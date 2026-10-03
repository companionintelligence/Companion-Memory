import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { HbpeNotifyService } from '@ci/common/hbpe';
import { EventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { CalendarEventService } from '../CalendarEventService';
import { EVENT_TIME_REOPENER } from '../eventTimeReopener';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

/**
 * The CTI aggregate contract: the ci.entities base row is the SOLE owner of
 * title/description, the detail row carries only event-specific data, and the
 * service composes/routes accordingly.
 */
describe('CalendarEventService CTI aggregate', () => {
  let service: CalendarEventService;
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
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let hbpeNotify: { notifyEvents: jest.Mock };
  /** What PipelineModule binds to EVENT_TIME_REOPENER. */
  let timeReopener: { reopenTimeDecisions: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    baseRepo = {
      create: jest.fn((x: Partial<EventBaseEntity>) => x),
      save: jest.fn(async (x: Partial<EventBaseEntity>) => x),
      find: jest.fn(async () => []),
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => ({
        id,
        name: 'Dinner',
      })),
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
            // A retime clears what the clean stage recorded about the old time.
            query: jest.fn(async () => []),
          }),
        ),
      },
    };

    hbpeNotify = { notifyEvents: jest.fn(async () => undefined) };
    timeReopener = { reopenTimeDecisions: jest.fn(async () => 0) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CalendarEventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: getRepositoryToken(EventBaseEntity), useValue: baseRepo },
        { provide: EventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: {} },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
        { provide: HbpeNotifyService, useValue: hbpeNotify },
        { provide: EVENT_TIME_REOPENER, useValue: timeReopener },
      ],
    }).compile();
    service = moduleRef.get(CalendarEventService);
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
    // The stored time and status are what `update` judges a move, or a call-off, against.
    const row = Object.assign(new EventEntity(), {
      id: 'e1',
      userId: 'user-1',
      startTime: new Date('2026-01-01T09:00:00Z'),
      endTime: null,
      status: 'confirmed',
    });
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

  it('update tells HBPE about the day a retimed event left, not just the day it moved to', async () => {
    // HBPE serializes tokens per UTC day and re-serializes only the days it is
    // notified about. Naming just the new day left the old one holding the
    // event's tokens, and a day older than HBPE's nightly budget is never
    // rewritten otherwise.
    const left = new Date('2026-03-02T09:00:00Z');
    const moved = new Date('2026-03-05T09:00:00Z');
    repo.findOne
      // The authorizing before-load inside the transaction …
      .mockResolvedValueOnce(
        Object.assign(new EventEntity(), { id: 'e1', userId: 'user-1', startTime: left }),
      )
      // … and the reload after the patch.
      .mockResolvedValueOnce(
        Object.assign(new EventEntity(), { id: 'e1', userId: 'user-1', startTime: moved }),
      );

    await service.update({ userId: 'user-1' } as ServiceContext, 'e1', { start_time: moved });

    expect(hbpeNotify.notifyEvents).toHaveBeenCalledTimes(1);
    expect(hbpeNotify.notifyEvents).toHaveBeenCalledWith('user-1', [left, moved]);
    // The same retime takes back what the pipeline decided about the old time.
    expect(timeReopener.reopenTimeDecisions).toHaveBeenCalledWith(['e1'], expect.anything());
  });

  it('remove tombstones the detail row instead of destroying the aggregate', async () => {
    repo.findOne.mockResolvedValueOnce(Object.assign(new EventEntity(), { id: 'e1', userId: 'user-1' }));

    const removed = await service.remove({ userId: 'user-1' } as ServiceContext, 'e1');

    expect(removed).toBe(true);
    expect(repo.update).toHaveBeenCalledWith({ id: 'e1' }, { isDeleted: true });
    // The base row must survive — deleting it would cascade the detail away and
    // make the deletion irreversible.
    expect(baseRepo.delete).not.toHaveBeenCalled();
    // … but it is deactivated, because graph readers see only the base row.
    expect(baseRepo.update).toHaveBeenCalledWith({ id: 'e1' }, { isActive: false });
  });

  it('remove refuses an already-deleted event (its authorizing load skips tombstones)', async () => {
    repo.findOne.mockResolvedValueOnce(null);

    const removed = await service.remove({ userId: 'user-1' } as ServiceContext, 'e1');

    expect(removed).toBe(false);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'e1', isDeleted: false }),
    });
    expect(repo.update).not.toHaveBeenCalled();
    expect(baseRepo.update).not.toHaveBeenCalled();
  });

  it('restore clears the tombstone and returns the event', async () => {
    repo.findOne
      // The tombstoned row the restore is authorized against …
      .mockResolvedValueOnce(
        Object.assign(new EventEntity(), { id: 'e1', userId: 'user-1', isDeleted: true }),
      )
      // … and the reload after the flag is cleared.
      .mockResolvedValueOnce(
        Object.assign(new EventEntity(), { id: 'e1', userId: 'user-1', isDeleted: false }),
      );

    const restored = await service.restore({ userId: 'user-1' } as ServiceContext, 'e1');

    expect(repo.findOne.mock.calls[0][0]).toEqual({
      where: expect.objectContaining({ id: 'e1', isDeleted: true }),
    });
    expect(repo.update).toHaveBeenCalledWith({ id: 'e1' }, { isDeleted: false });
    expect(baseRepo.update).toHaveBeenCalledWith({ id: 'e1' }, { isActive: true });
    expect(restored?.id).toBe('e1');
  });

  it('restore is a no-op when nothing with that id was deleted', async () => {
    repo.findOne.mockResolvedValueOnce(null);

    const restored = await service.restore({ userId: 'user-1' } as ServiceContext, 'e1');

    expect(restored).toBeNull();
    expect(repo.update).not.toHaveBeenCalled();
    expect(baseRepo.update).not.toHaveBeenCalled();
  });

  it('findById hides a tombstoned event from readers', async () => {
    repo.findOne.mockResolvedValueOnce(null);

    const found = await service.findById({ userId: 'user-1' } as ServiceContext, 'e1');

    expect(found).toBeNull();
    expect(repo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'e1', isDeleted: false }),
    });
  });
});
