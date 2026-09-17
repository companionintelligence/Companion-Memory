import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

const ctx = { userId: 'user-1' } as UserServiceContext;

/**
 * An inverted time pair is rejected in the SERVICE, so every caller inherits it.
 *
 * The guard used to live only in `rescheduleEvent`, so the same user drag came
 * back 400 through one mutation and an opaque 500 (the `events_time_order`
 * CHECK, surfaced raw) through `scheduleTask`. `CandidateService.accept` had no
 * guard at all and passes a caller-supplied start/end straight to `create`.
 */
describe('CalendarEventService — time-order guard', () => {
  let service: CalendarEventService;
  let repo: { findOne: jest.Mock; save: jest.Mock; find: jest.Mock; update: jest.Mock };

  async function setup(row: EventEntity | null = null) {
    repo = {
      findOne: jest.fn(async () => row),
      save: jest.fn(async (entity: EventEntity) => entity),
      find: jest.fn(async () => []),
      update: jest.fn(async () => undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CalendarEventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: getRepositoryToken(EventBaseEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: EventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: { getRepository: jest.fn() } },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    }).compile();

    service = moduleRef.get(CalendarEventService);
  }

  it('rejects a create whose end precedes its start, before it reaches the CHECK', async () => {
    await setup();

    await expect(
      service.create(ctx, {
        title: 'Backwards',
        start_time: new Date('2026-09-11T17:00:00Z'),
        end_time: new Date('2026-09-11T16:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Rejected at the boundary — nothing was written.
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects a reschedule whose end precedes its start', async () => {
    await setup({
      id: 'e1',
      startTime: new Date('2026-09-11T14:00:00Z'),
      endTime: new Date('2026-09-11T15:00:00Z'),
      sourceSystem: null,
    } as EventEntity);

    await expect(
      service.reschedule(
        ctx as ServiceContext,
        'e1',
        new Date('2026-09-11T17:00:00Z'),
        new Date('2026-09-11T16:00:00Z'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('allows equal instants — the constraint is start <= end, and a zero-length marker is real', async () => {
    await setup();
    const instant = new Date('2026-09-11T17:00:00Z');

    // Reaches the write path rather than throwing; the transaction itself is
    // not exercised here (see the CTI tests for that), only the guard.
    await expect(
      service.create(ctx, { title: 'Marker', start_time: instant, end_time: instant }),
    ).rejects.not.toBeInstanceOf(BadRequestException);
  });
});
