import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventEntity } from '../../entities/EventEntity';
import { ContentService } from '../ContentService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

describe('ContentService CTI aggregate', () => {
  let service: ContentService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let baseRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    metadata: { columns: unknown[] };
  };
  let deltas: {
    entityCreated: jest.Mock;
    entityUpdated: jest.Mock;
    entityDeleted: jest.Mock;
    recordMany: jest.Mock;
  };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    deltas = {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
    };
    baseRepo = {
      create: jest.fn((x: Partial<ContentBaseEntity>) => x),
      save: jest.fn(async (x: Partial<ContentBaseEntity>) => x),
      find: jest.fn(async () => []),
      update: jest.fn(async () => ({ affected: 1 })),
      delete: jest.fn(async () => ({ affected: 1 })),
      metadata: { columns: Array.from({ length: 10 }) },
    };
    repo = {
      findOne: jest.fn(),
      find: jest.fn(async () => []),
      create: jest.fn((x: Partial<ContentEntity>) => x),
      save: jest.fn(async (x: Partial<ContentEntity>) => ({ ...x, id: x.id ?? 'c1' })),
      createQueryBuilder: jest.fn(),
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown => (cls === ContentBaseEntity ? baseRepo : repo),
          }),
        ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
        { provide: getRepositoryToken(ContentBaseEntity), useValue: baseRepo },
        { provide: getRepositoryToken(EventEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: GraphDeltaWriter, useValue: deltas },
      ],
    }).compile();
    service = moduleRef.get(ContentService);
  });

  it('create writes base (title as name) and detail with the SAME uuid', async () => {
    const [content] = await service.create(ctx, {
      id: 'c1',
      title: 'Example page',
      type: 'web-page',
      url: 'https://example.com',
    });

    expect(baseRepo.save).toHaveBeenCalledTimes(1);
    expect(baseRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'c1',
      name: 'Example page',
      userId: 'user-1',
      linkedTable: 'content',
      linkedId: 'c1',
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save.mock.calls[0][0]).not.toHaveProperty('title');
    expect(content.title).toBe('Example page');
    expect(deltas.entityCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'c1',
        entityType: 'Content',
        name: 'Example page',
        changeSource: 'ContentService.create',
      }),
    );
  });

  it('findById composes title from the base row', async () => {
    repo.findOne.mockResolvedValue(
      Object.assign(new ContentEntity(), { id: 'c1', userId: 'user-1', type: 'web-page' }),
    );
    baseRepo.find.mockResolvedValue([
      Object.assign(new ContentBaseEntity(), { id: 'c1', name: 'Example page', description: null }),
    ]);

    const content = await service.findById({ userId: 'user-1' } as ServiceContext, 'c1');

    expect(content?.title).toBe('Example page');
  });
});
