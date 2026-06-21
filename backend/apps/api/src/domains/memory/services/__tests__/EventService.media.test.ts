import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventEntity } from '../../entities/EventEntity';
import type { CreateEventDto } from '../../types';
import { EventService } from '../EventService';

describe('EventService.create — media linking (ci.event_files)', () => {
  let service: EventService;
  let repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let dataSource: { query: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;
  const base = (): CreateEventDto =>
    ({ title: 'x', start_time: new Date('2026-01-01T00:00:00Z') }) as CreateEventDto;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: Partial<EventEntity>) => x),
      save: jest.fn(async (x: Partial<EventEntity>) => ({ ...x, id: 'event-1' })),
    };
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    const mod = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = mod.get(EventService);
  });

  it('links each media file to the event idempotently', async () => {
    await service.create(ctx, {
      ...base(),
      media: [{ file_id: 'file-a', role: 'attachment' }, { file_id: 'file-b' }],
    });

    expect(dataSource.query).toHaveBeenCalledTimes(2);
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ci\.event_files/);
    expect(sql).toMatch(/ON CONFLICT \(event_id, file_id\) DO NOTHING/);
    expect(params).toEqual(['event-1', 'file-a', 'attachment']);
    expect(dataSource.query.mock.calls[1][1]).toEqual(['event-1', 'file-b', null]);
  });

  it('does nothing when no media is provided', async () => {
    await service.create(ctx, base());
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('skips media entries without a file_id', async () => {
    await service.create(ctx, { ...base(), media: [{ file_id: '' }] });
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
