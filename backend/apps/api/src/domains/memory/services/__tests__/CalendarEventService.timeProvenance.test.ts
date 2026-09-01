import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, getMetadataArgsStorage } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import type { CreateEventDto } from '../../types';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

/**
 * `time_source` / `time_precision` survive the DTO → entity hop.
 *
 * This is its own file because the failure mode is invisible in every other
 * one. `repository.create()` matches ingress keys against PROPERTY names, and
 * silently discards anything it does not recognise — so a DTO field that is not
 * renamed in `toEntityFields`, or a column that was never declared on
 * `EventEntity`, produces no error, no warning and no write. For this
 * particular pair that is the worst possible outcome: the row still gets its
 * fabricated import-time `start_time`, and loses the only thing that said the
 * instant was fabricated. The bug would look exactly like the bug it was
 * supposed to fix.
 *
 * Two assertions, because it takes both to be safe: the service must rename the
 * key, and the entity must declare the column it is renamed to.
 */
describe('CalendarEventService — timestamp provenance reaches the entity', () => {
  let service: CalendarEventService;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    manager: { transaction: jest.Mock };
  };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    const baseRepo = {
      create: jest.fn((x: Partial<EventBaseEntity>) => x),
      save: jest.fn(async (x: Partial<EventBaseEntity>) => x),
      find: jest.fn(async () => []),
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: Partial<EventEntity>) => x),
      save: jest.fn(async (x: Partial<EventEntity>) => ({ ...x, id: x.id ?? 'inserted-id' })),
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
        CalendarEventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: getRepositoryToken(EventBaseEntity), useValue: baseRepo },
        { provide: EventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: {} },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    }).compile();

    service = moduleRef.get(CalendarEventService);
  });

  const undatedDto = (): CreateEventDto =>
    ({
      title: 'Home',
      // The import wall clock, standing in for a date the source never gave.
      start_time: new Date('2026-08-21T04:56:01.296Z'),
      time_source: 'ingest',
      time_precision: 'unknown',
      source_type: 'ci-import-tools',
      source_system: 'google_maps_places',
      source_id: 'gmaps:place:home',
    }) as CreateEventDto;

  it('renames the snake_case DTO keys to the entity property names', async () => {
    await service.create(ctx, undatedDto());

    const created = repo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.timeSource).toBe('ingest');
    expect(created.timePrecision).toBe('unknown');
  });

  it('declares the columns those property names map to', () => {
    // The rename above is only half the trip: an unrecognised PROPERTY is
    // dropped just as silently as an unrecognised key. Read from TypeORM's own
    // metadata rather than from the class, so a decorator that was deleted or
    // never applied fails here instead of in production.
    const columns = getMetadataArgsStorage()
      .filterColumns(EventEntity)
      .map((c) => ({ property: c.propertyName, name: c.options.name }));

    expect(columns).toContainEqual({ property: 'timeSource', name: 'time_source' });
    expect(columns).toContainEqual({ property: 'timePrecision', name: 'time_precision' });
  });

  it('leaves both NULL when the caller asserts nothing', async () => {
    // NULL means "unexamined" — TemporalRepairStage's candidate set and the
    // events-timestamped-at-import doctor check both depend on that reading, so
    // the service must not invent a default.
    await service.create(ctx, {
      title: 'a dated thing',
      start_time: new Date('2024-03-02T10:00:00Z'),
      source_type: 'manual',
    } as CreateEventDto);

    const created = repo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.timeSource).toBeUndefined();
    expect(created.timePrecision).toBeUndefined();
  });
});
