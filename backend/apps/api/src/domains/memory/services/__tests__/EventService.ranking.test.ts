import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventEntity } from '../../entities/EventEntity';
import type { CreateEventDto } from '../../types';
import { EventService } from '../EventService';

describe('EventService.create — ranking + consent columns', () => {
  let service: EventService;
  let repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;
  const base = (): CreateEventDto =>
    ({ title: 'x', start_time: new Date('2026-01-01T00:00:00Z') }) as CreateEventDto;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: Partial<EventEntity>) => x),
      save: jest.fn(async (x: Partial<EventEntity>) => ({ ...x, id: x.id ?? 'id' })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: {} },
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

describe('EventEntity.toEgressType — ranking + consent surfaced', () => {
  it('exposes salience, accessCount, lastAccessed, sharingLevel', () => {
    const accessed = new Date('2026-02-02T00:00:00Z');
    const egress = EventEntity.toEgressType({
      id: 'e1',
      salience: 0.7,
      accessCount: 4,
      lastAccessed: accessed,
      sharingLevel: 'household',
    } as EventEntity);

    expect(egress.salience).toBe(0.7);
    expect(egress.accessCount).toBe(4);
    expect(egress.lastAccessed).toBe(accessed);
    expect(egress.sharingLevel).toBe('household');
  });
});
