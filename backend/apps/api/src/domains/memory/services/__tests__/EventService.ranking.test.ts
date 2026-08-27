import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import type { CreateEventDto } from '../../types';
import { EventService } from '../EventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

describe('EventService.create — ranking + consent columns', () => {
  let service: EventService;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let baseRepo: { create: jest.Mock; save: jest.Mock; find: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;
  const base = (): CreateEventDto =>
    ({ title: 'x', start_time: new Date('2026-01-01T00:00:00Z') }) as CreateEventDto;

  beforeEach(async () => {
    baseRepo = {
      create: jest.fn((x: Partial<EventBaseEntity>) => x),
      save: jest.fn(async (x: Partial<EventBaseEntity>) => x),
      find: jest.fn(async () => []),
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: Partial<EventEntity>) => x),
      save: jest.fn(async (x: Partial<EventEntity>) => ({ ...x, id: x.id ?? 'id' })),
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
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    }).compile();
    service = moduleRef.get(EventService);
  });

  it('persists an explicit sharing_level (consent scope)', async () => {
    await service.create(ctx, { ...base(), sharing_level: 'household' });
    expect(repo.save.mock.calls[0][0].sharingLevel).toBe('household');
  });

  it('does not force sharing_level when omitted (DB default `private` applies)', async () => {
    await service.create(ctx, base());
    expect(repo.save.mock.calls[0][0].sharingLevel).toBeUndefined();
  });
});

describe('EventEntity.toEgressType — consent surfaced, recency gone', () => {
  it('exposes sharingLevel and no longer emits lastAccessed', () => {
    const egress = EventEntity.toEgressType({
      id: 'e1',
      sharingLevel: 'household',
    } as EventEntity);

    expect(egress.sharingLevel).toBe('household');

    // ci.events.last_accessed was dropped (migration 20260826202418) after it
    // spent its whole life NULL — nothing ever wrote it on a read path and
    // nothing read it. Re-adding the egress key would resurrect a field with no
    // writer, so assert on the emitted key set, not just the value.
    expect(Object.keys(egress)).not.toContain('lastAccessed');
  });
});
