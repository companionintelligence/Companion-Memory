import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, getMetadataArgsStorage } from 'typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import type { CreateEventDto, UpdateEventDto } from '../../types';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

/**
 * The calendar-shape fields — is_all_day, is_recurring, recurrence_pattern,
 * confidence_score — survive BOTH halves of the CRUD pair.
 *
 * Same silent-drop mechanism as the timestamp-provenance file next to this one:
 * `repository.create()` matches ingress keys against PROPERTY names and
 * discards anything else without a word. What made these four worse is that
 * ci.events DEFAULTs every one of them (false / false / NULL / 1.0), so the
 * lost write lands on a value that looks deliberate — an all-day Christmas
 * stored as a midnight point event, an RRULE series master stored as a one-off,
 * a 0.4-confidence geocode claiming ground truth to HBPE.
 *
 * The update half fails the other way round: guarded on truthiness, a flag
 * could be set and never cleared, so `isAllDay: false` from the edit modal
 * returned success and changed nothing.
 */
describe('CalendarEventService — calendar flags survive create and update', () => {
  let service: CalendarEventService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    manager: { transaction: jest.Mock; query: jest.Mock };
  };
  let baseRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  let deltas: ReturnType<typeof noopGraphDeltaWriter>;

  beforeEach(async () => {
    deltas = noopGraphDeltaWriter();
    baseRepo = {
      create: jest.fn((x: Partial<EventBaseEntity>) => x),
      save: jest.fn(async (x: Partial<EventBaseEntity>) => x),
      find: jest.fn(async () => []),
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => ({ id, name: 'Standup' })),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn(async () => []),
      create: jest.fn((x: Partial<EventEntity>) => x),
      save: jest.fn(async (x: Partial<EventEntity>) => ({ ...x, id: x.id ?? 'inserted-id' })),
      update: jest.fn(async () => ({ affected: 1 })),
      manager: {
        // ci.record_sources ledger writes go through manager.query.
        query: jest.fn(async () => []),
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown => (cls === EventBaseEntity ? baseRepo : repo),
          }),
        ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CalendarEventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: getRepositoryToken(EventBaseEntity), useValue: baseRepo },
        { provide: EventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: {} },
        { provide: GraphDeltaWriter, useValue: deltas },
      ],
    }).compile();

    service = moduleRef.get(CalendarEventService);
  });

  const created = () => repo.create.mock.calls[0][0] as Record<string, unknown>;
  const patched = () => repo.update.mock.calls[0][1] as Record<string, unknown>;

  describe('create', () => {
    it('renames the snake_case DTO keys to the entity property names', async () => {
      // A Google series master: all-day, weekly, geocoded off a city centroid.
      await service.create(ctx, {
        title: 'Christmas Day',
        start_time: new Date('2026-12-25T00:00:00Z'),
        is_all_day: true,
        is_recurring: true,
        recurrence_pattern: { freq: 'YEARLY' },
        confidence_score: 0.77,
      } as CreateEventDto);

      expect(created()).toMatchObject({
        isAllDay: true,
        isRecurring: true,
        recurrencePattern: { freq: 'YEARLY' },
        confidenceScore: 0.77,
      });
    });

    it('declares the columns those property names map to', () => {
      // The rename is only half the trip: an unrecognised PROPERTY is dropped
      // just as silently as an unrecognised key. Read TypeORM's own metadata so
      // a decorator that was deleted or never applied fails here.
      const columns = getMetadataArgsStorage()
        .filterColumns(EventEntity)
        .map((c) => ({ property: c.propertyName, name: c.options.name }));

      expect(columns).toContainEqual({ property: 'isAllDay', name: 'is_all_day' });
      expect(columns).toContainEqual({ property: 'isRecurring', name: 'is_recurring' });
      expect(columns).toContainEqual({ property: 'recurrencePattern', name: 'recurrence_pattern' });
      expect(columns).toContainEqual({ property: 'confidenceScore', name: 'confidence_score' });
    });

    it('carries false and 0 through, since those are the values the DEFAULT hides', async () => {
      // The guards are `!== undefined` for exactly this: truthiness would drop
      // `confidence_score: 0` and let the row claim the column default of 1.0.
      await service.create(ctx, {
        title: 'a guess',
        start_time: new Date('2026-01-01T09:00:00Z'),
        is_all_day: false,
        is_recurring: false,
        confidence_score: 0,
      } as CreateEventDto);

      expect(created()).toMatchObject({ isAllDay: false, isRecurring: false, confidenceScore: 0 });
    });

    it('leaves them unset when the caller says nothing, so the column defaults apply', async () => {
      await service.create(ctx, {
        title: 'a plain event',
        start_time: new Date('2026-01-01T09:00:00Z'),
      } as CreateEventDto);

      expect(created().isAllDay).toBeUndefined();
      expect(created().isRecurring).toBeUndefined();
      expect(created().recurrencePattern).toBeUndefined();
      expect(created().confidenceScore).toBeUndefined();
    });

    it('drops an explicit null status rather than writing NULL over the default', async () => {
      // `status NOT IN (...)` is three-valued, so a NULL-status row is invisible
      // on every calendar surface. EventResolver forwards a nullable status
      // verbatim, which makes this reachable from the public API.
      await service.create(ctx, {
        title: 'Dentist',
        start_time: new Date('2026-09-10T14:00:00Z'),
        status: null,
      } as unknown as CreateEventDto);

      expect(created()).not.toHaveProperty('status');
    });
  });

  describe('update', () => {
    beforeEach(() => {
      // The stored time and status are what `update` judges a move, or a call-off, against.
      repo.findOne.mockResolvedValue(
        Object.assign(new EventEntity(), {
          id: 'e1',
          userId: 'user-1',
          startTime: new Date('2026-01-01T09:00:00Z'),
          endTime: null,
          status: 'confirmed',
        }),
      );
      baseRepo.find.mockResolvedValue([
        Object.assign(new EventBaseEntity(), { id: 'e1', name: 'Standup', description: null }),
      ]);
    });

    it('clears a flag that was wrongly set — false is a patch, not an omission', async () => {
      // The edit modal turning the all-day toggle off, and a series demoted to a
      // one-off: under the old truthiness guards both returned success and wrote
      // nothing.
      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', {
        is_all_day: false,
        is_recurring: false,
        recurrence_pattern: null,
        is_private: false,
        priority: 0,
        confidence_score: 0,
        end_time: null,
      } as unknown as UpdateEventDto);

      expect(patched()).toMatchObject({
        isAllDay: false,
        isRecurring: false,
        recurrencePattern: null,
        isPrivate: false,
        priority: 0,
        confidenceScore: 0,
        endTime: null,
      });
    });

    it('still ignores the fields the patch does not mention', async () => {
      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', { category: 'social' });

      expect(patched()).toEqual({ category: 'social' });
    });

    it('clears the description when the event page saves it empty', async () => {
      baseRepo.findOne.mockResolvedValue({ id: 'e1', name: 'Standup', description: 'Agenda' });

      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', { description: '' });

      expect(baseRepo.update).toHaveBeenCalledWith({ id: 'e1' }, { description: null });
      expect(deltas.entityUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ changedFields: { description: { old: 'Agenda', new: null } } }),
      );
    });

    it('treats a description of only whitespace as cleared', async () => {
      baseRepo.findOne.mockResolvedValue({ id: 'e1', name: 'Standup', description: 'Agenda' });

      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', { description: '   ' });

      expect(baseRepo.update).toHaveBeenCalledWith({ id: 'e1' }, { description: null });
    });

    it('does not rewrite or record an empty description that is already empty', async () => {
      // The drawer sends its whole form, so a title-only save of an event
      // imported with '' hands back '' for the description too.
      baseRepo.findOne.mockResolvedValue({ id: 'e1', name: 'Standup', description: '' });

      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', {
        title: 'Standup',
        description: '',
      });

      expect(baseRepo.update).not.toHaveBeenCalled();
      expect(deltas.entityUpdated).not.toHaveBeenCalled();
    });

    it('leaves the description alone when the patch sends none', async () => {
      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', {
        description: null,
        category: 'social',
      } as unknown as UpdateEventDto);

      expect(baseRepo.update).not.toHaveBeenCalled();
    });

    it('does not rewrite or record a title that came back unchanged', async () => {
      // The event page sends the stored title with every save of its description.
      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', { title: 'Standup' });

      expect(baseRepo.update).not.toHaveBeenCalled();
      expect(deltas.entityUpdated).not.toHaveBeenCalled();
    });

    it('records a real rename with the title it replaced', async () => {
      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', { title: 'Team standup' });

      expect(baseRepo.update).toHaveBeenCalledWith({ id: 'e1' }, { name: 'Team standup' });
      expect(deltas.entityUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ changedFields: { name: { old: 'Standup', new: 'Team standup' } } }),
      );
    });

    it('refuses to clear the tombstone — un-deleting is restore(), not a field patch', async () => {
      // Deliberately still truthiness-guarded: `restore` re-publishes the search
      // index and the graph delta, and a field patch would bring the row back
      // invisible to both.
      await service.update({ userId: 'user-1' } as ServiceContext, 'e1', {
        is_deleted: false,
        category: 'social',
      });

      expect(patched()).not.toHaveProperty('isDeleted');
    });
  });
});
