import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventEntity } from '../../entities/EventEntity';
import { EventService } from '../EventService';

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

describe('EventService — event-type ("how") filtering', () => {
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
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
      ],
    })
      .compile()
      .then((moduleRef) => {
        service = moduleRef.get(EventService);
      });
  }

  describe('getEntitiesForEvents', () => {
    it('narrows by event_type when eventTypes is provided', async () => {
      await setup([{ event_id: 'e1' }]);

      const result = await service.getEntitiesForEvents(ctx, {
        limit: 25,
        eventTypes: ['visited', 'messaged'],
      });

      const typeFilter = qb.calls.andWhere?.find(([clause]) =>
        String(clause).includes('event.event_type IN (:...eventTypes)'),
      );
      expect(typeFilter).toBeDefined();
      expect(typeFilter?.[1]).toEqual({ eventTypes: ['visited', 'messaged'] });
      expect(result).toEqual([{ id: 'e1', type: 'event' }]);
    });

    it('does not add an event_type filter when eventTypes is empty', async () => {
      await setup([]);

      await service.getEntitiesForEvents(ctx, { limit: 25, eventTypes: [] });

      const typeFilter = (qb.calls.andWhere ?? []).find(([clause]) =>
        String(clause).includes('event.event_type IN'),
      );
      expect(typeFilter).toBeUndefined();
    });

    it('does not add an event_type filter when eventTypes is omitted', async () => {
      await setup([]);

      await service.getEntitiesForEvents(ctx, { limit: 25 });

      const typeFilter = (qb.calls.andWhere ?? []).find(([clause]) =>
        String(clause).includes('event.event_type IN'),
      );
      expect(typeFilter).toBeUndefined();
    });
  });

  describe('getDistinctEventTypes', () => {
    it('selects distinct, non-null event types for the user', async () => {
      await setup([{ event_type: 'called' }, { event_type: 'visited' }]);

      const result = await service.getDistinctEventTypes(ctx);

      expect(qb.calls.select?.[0]?.[0]).toBe('DISTINCT event.event_type');
      expect(qb.calls.where?.[0]?.[0]).toContain('event.user_id = :userId');
      expect(
        (qb.calls.andWhere ?? []).some(([clause]) => String(clause).includes('event.event_type IS NOT NULL')),
      ).toBe(true);
      expect(result).toEqual(['called', 'visited']);
    });
  });
});
