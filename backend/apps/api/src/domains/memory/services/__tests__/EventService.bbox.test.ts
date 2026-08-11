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
    where: record('where'),
    andWhere: record('andWhere'),
    limit: record('limit'),
    orderBy: record('orderBy'),
    getRawMany: jest.fn(async () => rawMany),
    calls,
  };

  return qb;
}

const ST_WITHIN = 'ST_Within(event.location_coordinates::geometry, ST_MakeEnvelope(';

describe('EventService — bounding-box ("search this area") filtering', () => {
  let service: EventService;
  let qb: ReturnType<typeof makeQueryBuilder>;

  const ctx = { userId: 'user-1' } as ServiceContext;

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

  const bboxClause = () => (qb.calls.andWhere ?? []).find(([clause]) => String(clause).includes(ST_WITHIN));

  it('adds an ST_Within / ST_MakeEnvelope clause for a valid [minLon, minLat, maxLon, maxLat] box', async () => {
    await setup([{ event_id: 'e1' }]);

    const result = await service.getEntitiesForEvents(ctx, {
      limit: 25,
      bbox: [-122.5, 37.7, -122.3, 37.8],
    });

    const clause = bboxClause();
    expect(clause).toBeDefined();
    // Envelope args are bound as named params in [xmin, ymin, xmax, ymax] order.
    expect(clause?.[1]).toEqual({ minLon: -122.5, minLat: 37.7, maxLon: -122.3, maxLat: 37.8 });
    expect(result).toEqual([{ id: 'e1', type: 'event' }]);
  });

  it('ignores the box when bbox is omitted', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, { limit: 25 });

    expect(bboxClause()).toBeUndefined();
  });

  it('ignores a malformed box (wrong length)', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, { limit: 25, bbox: [-122.5, 37.7, -122.3] });

    expect(bboxClause()).toBeUndefined();
  });

  it('ignores a box carrying non-finite values', async () => {
    await setup([]);

    await service.getEntitiesForEvents(ctx, { limit: 25, bbox: [-122.5, Number.NaN, -122.3, 37.8] });

    expect(bboxClause()).toBeUndefined();
  });
});
