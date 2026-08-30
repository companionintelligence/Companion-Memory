import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { EventService } from '../EventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

/** Chainable query-builder mock recording every call, returning fixed raw rows. */
function makeQueryBuilder(rawMany: unknown[]) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => {
    calls[name] ??= [];

    return (...args: unknown[]) => {
      calls[name].push(args);

      return qb;
    };
  };

  const qb = {
    select: record('select'),
    addSelect: record('addSelect'),
    innerJoin: record('innerJoin'),
    leftJoin: record('leftJoin'),
    where: record('where'),
    andWhere: record('andWhere'),
    limit: record('limit'),
    orderBy: record('orderBy'),
    addOrderBy: record('addOrderBy'),
    getRawMany: jest.fn(async () => rawMany),
    calls,
  };

  return qb;
}

describe('EventService.findMapPins', () => {
  let service: EventService;
  let qb: ReturnType<typeof makeQueryBuilder>;

  const ctx = { userId: 'user-1' } as ServiceContext;

  const row = (overrides: Record<string, unknown> = {}) => ({
    event_id: 'e1',
    title: 'Golden Gate Park',
    start_time: new Date('2026-05-01T10:00:00Z'),
    end_time: null,
    event_type: 'visited',
    location_name: 'San Francisco',
    time_source: 'source',
    latitude: 37.77,
    longitude: -122.42,
    ...overrides,
  });

  function setup(rawMany: unknown[]) {
    qb = makeQueryBuilder(rawMany);
    const dataSource = {
      getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => qb) })),
    };

    return Test.createTestingModule({
      providers: [
        EventService,
        { provide: getRepositoryToken(EventEntity), useValue: {} },
        { provide: getRepositoryToken(EventBaseEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    })
      .compile()
      .then((moduleRef) => {
        service = moduleRef.get(EventService);
      });
  }

  const clause = (needle: string) => (qb.calls.andWhere ?? []).find(([sql]) => String(sql).includes(needle));

  it('projects raw rows to pins', async () => {
    await setup([row()]);

    const pins = await service.findMapPins(ctx, { limit: 100 });

    expect(pins).toEqual([
      {
        id: 'e1',
        title: 'Golden Gate Park',
        startTime: new Date('2026-05-01T10:00:00Z'),
        endTime: null,
        eventType: 'visited',
        locationName: 'San Francisco',
        timeSource: 'source',
        latitude: 37.77,
        longitude: -122.42,
      },
    ]);
  });

  it('carries an ingest-fabricated time source through to the pin', async () => {
    // A Google Maps saved place ("Home", "Work", "Gym") has no real visit time —
    // its `start_time` is only the import wall clock, stamped because the column
    // is NOT NULL. The map has to know that to caption the pin "Date unknown"
    // instead of a fabricated moment; dropping this field is what let the map
    // show "Yesterday 9:56 PM" for a saved place imported today.
    await setup([row({ time_source: 'ingest' })]);

    const [pin] = await service.findMapPins(ctx, { limit: 100 });

    expect(pin.timeSource).toBe('ingest');
  });

  it('forces located-only, whatever the caller passed', async () => {
    await setup([]);

    await service.findMapPins(ctx, { limit: 100, hasLocation: false });

    expect(
      clause('COALESCE(event.location_coordinates, location_entity.location_point) IS NOT NULL'),
    ).toBeDefined();
  });

  it('scopes to the caller and caps the read at `limit`', async () => {
    await setup([]);

    await service.findMapPins(ctx, { limit: 5000 });

    expect(qb.calls.where[0]).toEqual(['event.user_id = :userId', { userId: 'user-1' }]);
    expect(qb.calls.limit[0]).toEqual([5000]);
  });

  it('applies the same filters the explorer uses (bbox / dates / activity)', async () => {
    await setup([]);

    await service.findMapPins(ctx, {
      limit: 100,
      bbox: [-122.5, 37.7, -122.3, 37.8],
      startTime: new Date('2026-01-01T00:00:00Z'),
      eventTypes: ['visited'],
    });

    expect(
      clause('ST_Within(COALESCE(event.location_coordinates, location_entity.location_point)::geometry'),
    ).toBeDefined();
    expect(clause('event.start_time >= :startTime')).toBeDefined();
    expect(clause('event.event_type IN (:...eventTypes)')).toBeDefined();
  });

  it('intersects an explicit id set (the text-query / tag candidates)', async () => {
    await setup([]);

    await service.findMapPins(ctx, { limit: 100, ids: ['a', 'b'] });

    expect(clause('event.event_id = ANY(:eventIds)')?.[1]).toEqual({ eventIds: ['a', 'b'] });
  });

  it('an empty id set matches nothing rather than everything', async () => {
    await setup([]);

    await service.findMapPins(ctx, { limit: 100, ids: [] });

    expect(clause('event.event_id = ANY(:eventIds)')?.[1]).toEqual({ eventIds: [] });
  });

  it('drops rows whose coordinates did not project — no pin at (0, 0)', async () => {
    await setup([row(), row({ event_id: 'e2', latitude: null, longitude: null })]);

    const pins = await service.findMapPins(ctx, { limit: 100 });

    expect(pins.map((pin) => pin.id)).toEqual(['e1']);
  });

  it('accepts numeric strings from the driver', async () => {
    await setup([row({ latitude: '37.77', longitude: '-122.42' })]);

    const [pin] = await service.findMapPins(ctx, { limit: 100 });

    expect(pin.latitude).toBe(37.77);
    expect(pin.longitude).toBe(-122.42);
  });

  it('orders newest first, with a deterministic tiebreak', async () => {
    await setup([]);

    await service.findMapPins(ctx, { limit: 100 });

    expect(qb.calls.orderBy[0]).toEqual(['event.start_time', 'DESC']);
    expect(qb.calls.addOrderBy[0]).toEqual(['event.event_id', 'DESC']);
  });
});
