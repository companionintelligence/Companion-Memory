import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

/** Chainable query-builder mock that records every call and returns a
 * configurable `getRawMany` result. */
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
    leftJoin: record('leftJoin'),
    where: record('where'),
    andWhere: record('andWhere'),
    limit: record('limit'),
    orderBy: record('orderBy'),
    getRawMany: jest.fn(async () => rawMany),
    calls,
  };

  return qb;
}

const ST_WITHIN =
  'ST_Within(COALESCE(event.location_coordinates, location_entity.location_point)::geometry, ST_MakeEnvelope(';

describe('CalendarEventService — bounding-box ("search this area") filtering', () => {
  let service: CalendarEventService;
  let qb: ReturnType<typeof makeQueryBuilder>;

  const ctx = { userId: 'user-1' } as ServiceContext;

  function setup(rawMany: unknown[]) {
    qb = makeQueryBuilder(rawMany);
    const dataSource = {
      getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => qb) })),
    };

    return Test.createTestingModule({
      providers: [
        CalendarEventService,
        { provide: getRepositoryToken(EventEntity), useValue: {} },
        { provide: getRepositoryToken(EventBaseEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: EventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    })
      .compile()
      .then((moduleRef) => {
        service = moduleRef.get(CalendarEventService);
      });
  }

  const bboxClause = () => (qb.calls.andWhere ?? []).find(([clause]) => String(clause).includes(ST_WITHIN));

  it('adds an ST_Within / ST_MakeEnvelope clause for a valid [minLon, minLat, maxLon, maxLat] box', async () => {
    await setup([{ event_id: 'e1' }]);

    const result = await service.getEntitiesForEvents(ctx, {
      limit: 25,
      areas: [[-122.5, 37.7, -122.3, 37.8]],
    });

    const clause = bboxClause();
    expect(clause).toBeDefined();
    // Envelope args are bound as named params in [xmin, ymin, xmax, ymax] order.
    expect(clause?.[1]).toEqual({ minLon0: -122.5, minLat0: 37.7, maxLon0: -122.3, maxLat0: 37.8 });
    expect(result).toEqual([{ id: 'e1', type: 'event' }]);
  });

  it('ORs several areas, so London and Paris match without the Channel between them', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, {
      limit: 25,
      areas: [
        [-0.5, 51.3, 0.3, 51.7],
        [2.2, 48.8, 2.5, 48.9],
      ],
    });

    const clause = bboxClause();
    expect(String(clause?.[0])).toMatch(/^\(ST_Within\(.* OR ST_Within\(.*\)$/);
    expect(String(clause?.[0]).match(/ST_MakeEnvelope/g)).toHaveLength(2);
    expect(clause?.[1]).toEqual({
      minLon0: -0.5,
      minLat0: 51.3,
      maxLon0: 0.3,
      maxLat0: 51.7,
      minLon1: 2.2,
      minLat1: 48.8,
      maxLon1: 2.5,
      maxLat1: 48.9,
    });
  });

  it('ORs the areas with the place names, so a named place matches without coordinates', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, {
      limit: 25,
      areas: [[2.2, 48.8, 2.5, 48.9]],
      places: ['Duranzo'],
    });

    const clause = bboxClause();
    const sql = String(clause?.[0]);

    // One predicate: (inside any rectangle) OR (name matches). Not two ANDed ones.
    expect(sql).toMatch(/^\(\(ST_Within\(.*\) OR \(\s*event\.location_entity_id IN \(/s);
    expect(sql).toContain('event.location_name ILIKE ANY(:placePatterns)');
    expect(clause?.[1]).toEqual({
      minLon0: 2.2,
      minLat0: 48.8,
      maxLon0: 2.5,
      maxLat0: 48.9,
      userId: 'user-1',
      placePatterns: ['%Duranzo%'],
    });
    expect((qb.calls.andWhere ?? []).filter(([c]) => String(c).includes('placePatterns'))).toHaveLength(1);
  });

  it('keeps the place names as their own clause when no area is given', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, { limit: 25, places: ['Duranzo'] });

    const placeClause = (qb.calls.andWhere ?? []).find(([c]) => String(c).includes('placePatterns'));

    expect(bboxClause()).toBeUndefined();
    expect(String(placeClause?.[0])).not.toContain('ST_Within');
    expect(placeClause?.[1]).toEqual({ userId: 'user-1', placePatterns: ['%Duranzo%'] });
  });

  it('ignores the box when areas are omitted', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, { limit: 25 });

    expect(bboxClause()).toBeUndefined();
  });

  it('drops a malformed area (wrong length) and keeps the rest', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, {
      limit: 25,
      areas: [
        [-122.5, 37.7, -122.3],
        [2.2, 48.8, 2.5, 48.9],
      ],
    });

    expect(String(bboxClause()?.[0]).match(/ST_MakeEnvelope/g)).toHaveLength(1);
    expect(bboxClause()?.[1]).toEqual({ minLon0: 2.2, minLat0: 48.8, maxLon0: 2.5, maxLat0: 48.9 });
  });

  it('ignores an area carrying non-finite values', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, { limit: 25, areas: [[-122.5, Number.NaN, -122.3, 37.8]] });

    expect(bboxClause()).toBeUndefined();
  });
});
