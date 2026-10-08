import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { HbpeNotifyService } from '@ci/common/hbpe';
import { bulkInsertIdempotent } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import type { CreateEventDto } from '../../types';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

jest.mock('@ci/common/persistence', () => ({
  ...jest.requireActual('@ci/common/persistence'),
  bulkInsertIdempotent: jest.fn(),
}));

const bulkInsertMock = bulkInsertIdempotent as jest.Mock;

/** Rows the batch path handed to the insert, as stored. */
function insertedRows(): EventEntity[] {
  return bulkInsertMock.mock.calls[0][0].entities as EventEntity[];
}

describe('CalendarEventService — recurrence rules on write', () => {
  let service: CalendarEventService;
  let repo: Record<string, unknown>;

  const ctx = { userId: 'user-1' } as UserServiceContext;

  function dto(over: Partial<CreateEventDto>): CreateEventDto {
    return {
      title: 'Standup',
      start_time: new Date('2026-09-07T16:00:00Z'),
      source_type: 'ETL',
      source_system: 'calendar',
      source_id: `standup-${Math.random()}@example.com`,
      is_recurring: true,
      ...over,
    } as CreateEventDto;
  }

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
      query: jest.fn(async () => []),
    };
    repo = { create: jest.fn((x: Partial<EventEntity>) => x as EventEntity) };
    repo.manager = {
      transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
        cb({
          getRepository: (cls: unknown): unknown => (cls === EventBaseEntity ? baseRepo : repo),
          withRepository: (): unknown => repo,
        }),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CalendarEventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: getRepositoryToken(EventBaseEntity), useValue: baseRepo },
        { provide: EventService, useValue: { send: jest.fn(), sendMany: jest.fn() } },
        { provide: DataSource, useValue: {} },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
        { provide: HbpeNotifyService, useValue: { notifyEvents: jest.fn(async () => undefined) } },
      ],
    }).compile();

    service = moduleRef.get(CalendarEventService);
  });

  it('stores a synced series with its rule, and one whose rule would hang the calendar without it', async () => {
    const google = ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/Los_Angeles:20260914T090000'];

    await service.create(ctx, [
      dto({
        title: 'Weekly',
        metadata: { recurrenceRule: google, recurrenceTimeZone: 'America/Los_Angeles' },
      }),
      dto({
        title: 'Hourly forever',
        metadata: {
          recurrenceRule: ['RRULE:FREQ=HOURLY;BYHOUR=24'],
          recurrenceTimeZone: 'America/Los_Angeles',
        },
      }),
      dto({ title: 'Backwards', recurrence_pattern: { rrule: 'FREQ=DAILY;INTERVAL=-1', note: 'kept' } }),
    ]);

    const [weekly, hourly, backwards] = insertedRows();

    expect(weekly.metadata).toEqual({ recurrenceRule: google, recurrenceTimeZone: 'America/Los_Angeles' });
    // The event is kept, so it still shows once; only the rule is gone.
    expect(hourly.metadata).toEqual({ recurrenceTimeZone: 'America/Los_Angeles' });
    expect(hourly.isRecurring).toBe(true);
    expect(backwards.recurrencePattern).toEqual({ note: 'kept' });
  });

  it('stores a rule with both UNTIL and COUNT as written, in either order', async () => {
    const untilFirst = ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261020T160000Z;COUNT=10'];
    const countFirst = 'FREQ=WEEKLY;BYDAY=MO;COUNT=3;UNTIL=20261231T235959Z';

    await service.create(ctx, [
      dto({ metadata: { recurrenceRule: untilFirst, recurrenceTimeZone: 'America/Los_Angeles' } }),
      dto({ recurrence_pattern: { rrule: countFirst } }),
    ]);
    const [ruleInMetadata, ruleInPattern] = insertedRows();

    expect(ruleInMetadata.metadata).toEqual({
      recurrenceRule: untilFirst,
      recurrenceTimeZone: 'America/Los_Angeles',
    });
    expect(ruleInPattern.recurrencePattern).toEqual({ rrule: countFirst });
  });

  it('lets an edit store a rule with both UNTIL and COUNT', async () => {
    const aggregate = (service as unknown as { aggregate: { applyUpdate: () => Promise<unknown> } })
      .aggregate;
    const applyUpdate = jest.spyOn(aggregate, 'applyUpdate').mockResolvedValue(null);
    const rule = ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3;UNTIL=20261231T235959Z'];

    await expect(
      service.update(ctx, '0198f0a0-0000-7000-8000-000000000001', { metadata: { recurrenceRule: rule } }),
    ).resolves.toBeNull();
    await expect(
      service.update(ctx, '0198f0a0-0000-7000-8000-000000000001', {
        recurrence_pattern: { rrule: 'FREQ=DAILY;UNTIL=20261231;COUNT=3' },
      }),
    ).resolves.toBeNull();

    expect(applyUpdate).toHaveBeenNthCalledWith(
      1,
      ctx,
      '0198f0a0-0000-7000-8000-000000000001',
      expect.objectContaining({ detail: expect.objectContaining({ metadata: { recurrenceRule: rule } }) }),
      expect.anything(),
    );
    expect(applyUpdate).toHaveBeenNthCalledWith(
      2,
      ctx,
      '0198f0a0-0000-7000-8000-000000000001',
      expect.objectContaining({
        detail: expect.objectContaining({
          recurrencePattern: { rrule: 'FREQ=DAILY;UNTIL=20261231;COUNT=3' },
        }),
      }),
      expect.anything(),
    );
  });

  it('refuses an edit that would store such a rule, before writing the row', async () => {
    const findOne = jest.fn(async () => ({ id: 'stored', metadata: {}, recurrencePattern: null }));
    repo.findOne = findOne;
    const aggregate = (service as unknown as { aggregate: { applyUpdate: () => Promise<unknown> } })
      .aggregate;
    const applyUpdate = jest.spyOn(aggregate, 'applyUpdate').mockResolvedValue(null);

    await expect(
      service.update(ctx, '0198f0a0-0000-7000-8000-000000000001', {
        metadata: { recurrenceRule: ['RRULE:FREQ=HOURLY;INTERVAL=24;BYHOUR=5'] },
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.update(ctx, '0198f0a0-0000-7000-8000-000000000001', {
        recurrence_pattern: { rrule: 'FREQ=DAILY;BYMONTH=13' },
      }),
    ).rejects.toThrow(/Unsupported recurrence rule: BYMONTH/);
    // Both parts present no longer excuses either one being malformed.
    await expect(
      service.update(ctx, '0198f0a0-0000-7000-8000-000000000001', {
        recurrence_pattern: { rrule: 'FREQ=DAILY;UNTIL=20261231;COUNT=0' },
      }),
    ).rejects.toThrow('Unsupported recurrence rule: COUNT "0" is not a positive integer');
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('lets an edit hand back a refused rule the row already stores', async () => {
    // GeocodeBatchListener patches `metadata` with the row's own metadata plus
    // one key; a rule stored before the write check must not block that.
    const stored = ['RRULE:FREQ=HOURLY;INTERVAL=24;BYHOUR=5'];
    repo.findOne = jest.fn(async () => ({
      id: 'stored',
      metadata: { recurrenceRule: stored },
      recurrencePattern: null,
    }));
    const aggregate = (service as unknown as { aggregate: { applyUpdate: () => Promise<unknown> } })
      .aggregate;
    const applyUpdate = jest.spyOn(aggregate, 'applyUpdate').mockResolvedValue(null);

    await expect(
      service.update(ctx, '0198f0a0-0000-7000-8000-000000000001', {
        metadata: { recurrenceRule: [...stored], location_source: 'approximate' },
      }),
    ).resolves.toBeNull();
    expect(applyUpdate).toHaveBeenCalledTimes(1);

    await expect(
      service.update(ctx, '0198f0a0-0000-7000-8000-000000000001', {
        metadata: { recurrenceRule: ['RRULE:FREQ=HOURLY;INTERVAL=24;BYHOUR=6'] },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });
});
