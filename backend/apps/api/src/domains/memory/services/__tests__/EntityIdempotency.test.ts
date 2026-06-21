import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { ConceptEntity } from '../../entities/ConceptEntity';
import { PersonEntity } from '../../entities/PersonEntity';
import { ConceptService } from '../ConceptService';
import { PersonService } from '../PersonService';

const ctx = { userId: 'user-1' } as UserServiceContext;

function repoMock() {
  return {
    findOne: jest.fn(),
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: { id?: string }) => ({ ...x, id: x.id ?? 'inserted' })),
  };
}

const logger = { setContext: () => undefined, log: () => undefined, warn: () => undefined };

describe('PersonService.create — linked idempotency', () => {
  let service: PersonService;
  let repo: ReturnType<typeof repoMock>;
  let signal: { send: jest.Mock };

  beforeEach(async () => {
    repo = repoMock();
    signal = { send: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        PersonService,
        { provide: getRepositoryToken(PersonEntity), useValue: repo },
        { provide: LoggerService, useValue: logger },
        { provide: SignallingEventService, useValue: signal },
      ],
    }).compile();
    service = mod.get(PersonService);
  });

  const linked = { name: 'Dana', linkedTable: 'ci-import-tools:contact', linkedId: 'dana@x.com' };

  it('inserts when the linked key is new', async () => {
    repo.findOne.mockResolvedValue(null);
    await service.create(ctx, linked);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(signal.send).toHaveBeenCalledTimes(1);
  });

  it('returns the existing person on re-sync (no duplicate, no signal)', async () => {
    repo.findOne.mockResolvedValue({ id: 'existing', entityType: 'Person' });
    const result = await service.create(ctx, linked);
    expect(result.id).toBe('existing');
    expect(repo.save).not.toHaveBeenCalled();
    expect(signal.send).not.toHaveBeenCalled();
  });

  it('matches on (entityType, linkedTable, linkedId, user)', async () => {
    repo.findOne.mockResolvedValue(null);
    await service.create(ctx, linked);
    expect(repo.findOne.mock.calls[0][0].where).toMatchObject({
      entityType: 'Person',
      linkedTable: 'ci-import-tools:contact',
      linkedId: 'dana@x.com',
      user: { id: 'user-1' },
    });
  });

  it('without a linked key, always inserts (no lookup)', async () => {
    await service.create(ctx, { name: 'Anon' });
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('recovers from a 23505 race by returning the winner', async () => {
    repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner', entityType: 'Person' });
    repo.save.mockRejectedValueOnce({ code: '23505' });
    const result = await service.create(ctx, linked);
    expect(result.id).toBe('winner');
  });
});

describe('ConceptService.create — linked idempotency', () => {
  let service: ConceptService;
  let repo: ReturnType<typeof repoMock>;
  let signal: { send: jest.Mock };

  beforeEach(async () => {
    repo = repoMock();
    signal = { send: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        ConceptService,
        { provide: getRepositoryToken(ConceptEntity), useValue: repo },
        { provide: LoggerService, useValue: logger },
        { provide: SignallingEventService, useValue: signal },
      ],
    }).compile();
    service = mod.get(ConceptService);
  });

  const linked = { name: 'Project X', linkedTable: 'ci-import-tools:thread', linkedId: 'thr-1' };

  it('is idempotent on the linked key', async () => {
    repo.findOne.mockResolvedValue({ id: 'existing-concept', entityType: 'Concept' });
    const result = await service.create(ctx, linked);
    expect(result.id).toBe('existing-concept');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('inserts a new linked concept', async () => {
    repo.findOne.mockResolvedValue(null);
    await service.create(ctx, linked);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});
