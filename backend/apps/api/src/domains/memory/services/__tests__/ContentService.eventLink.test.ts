import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { ContentEntity } from '../../entities/ContentEntity';
import { EventEntity } from '../../entities/EventEntity';
import type { CreateContentDto } from '../../types';
import { ContentService } from '../ContentService';

describe('ContentService.create — event link', () => {
  let service: ContentService;
  let repo: { create: jest.Mock; save: jest.Mock };
  let eventRepo: { findOne: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: { id?: string }) => ({ ...x, id: x.id ?? 'content-1' })),
    };
    eventRepo = {
      findOne: jest.fn(async () => null),
    };
    const mod = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
        { provide: getRepositoryToken(EventEntity), useValue: eventRepo },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ContentService);
  });

  it('links content to its event when event is provided', async () => {
    await service.create(ctx, {
      type: 'attachment',
      mimetype: 'image/jpeg',
      url: 'https://store/abc.jpg',
      event: { id: 'event-9' },
    } as CreateContentDto);

    expect(repo.create.mock.calls[0][0]).toMatchObject({
      type: 'attachment',
      mimetype: 'image/jpeg',
      event: { id: 'event-9' },
      userId: 'user-1',
    });
  });

  it('omits the event relation when no event is given', async () => {
    await service.create(ctx, { type: 'note', text: 'hi' } as CreateContentDto);
    expect(repo.create.mock.calls[0][0].event).toBeUndefined();
  });

  // Regression: ci.content.user_id and the `user` relation map to the same DB
  // column. When the scalar was insert:false the owner was written via the
  // relation only and silently shadowed to NULL, which broke every user_id-scoped
  // read. The owner must be persisted on the scalar column and surface on egress.
  it('persists the owner on the scalar user_id column, not the relation', async () => {
    const [created] = await service.create(ctx, { type: 'note', text: 'hi' } as CreateContentDto);

    const persisted = repo.create.mock.calls[0][0];
    expect(persisted.userId).toBe('user-1');
    // The relation must NOT be the write path (it shadowed the column to NULL).
    expect(persisted.user).toBeUndefined();
    // ...and the owner round-trips through toEgressType.
    expect(created.userId).toBe('user-1');
  });
});

describe('ContentService.createMany — batch + event auto-link', () => {
  let service: ContentService;
  let repo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let eventRepo: { findOne: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: { id?: string }) => ({ ...x, id: x.id ?? 'content-new' })),
      findOne: jest.fn(async () => null),
    };
    eventRepo = {
      findOne: jest.fn(async () => null),
    };
    const mod = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
        { provide: getRepositoryToken(EventEntity), useValue: eventRepo },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ContentService);
  });

  it('auto-links to the event sharing the same provenance triple', async () => {
    eventRepo.findOne.mockResolvedValueOnce({ id: 'event-from-triple' });

    await service.createMany(ctx, [
      {
        type: 'Photo',
        source_type: 'import',
        source_system: 'facebook',
        source_id: 'photo-42',
      } as CreateContentDto,
    ]);

    // Event was looked up by the (user, source_type, source_system, source_id)
    // triple and linked onto the created content.
    expect(eventRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          sourceType: 'import',
          sourceSystem: 'facebook',
          sourceId: 'photo-42',
        }),
      }),
    );
    expect(repo.create.mock.calls[0][0]).toMatchObject({
      event: { id: 'event-from-triple' },
    });
  });

  it('stamps the owner on each bulk-ingested row', async () => {
    const [created] = await service.createMany(ctx, [
      {
        type: 'Photo',
        source_type: 'import',
        source_system: 'facebook',
        source_id: 'photo-99',
      } as CreateContentDto,
    ]);

    expect(repo.create.mock.calls[0][0].userId).toBe('user-1');
    expect(created.userId).toBe('user-1');
  });

  it('prefers an explicit event over the triple lookup', async () => {
    await service.createMany(ctx, [
      {
        type: 'Photo',
        source_type: 'import',
        source_system: 'facebook',
        source_id: 'photo-7',
        event: { id: 'explicit-event' },
      } as CreateContentDto,
    ]);

    expect(eventRepo.findOne).not.toHaveBeenCalled();
    expect(repo.create.mock.calls[0][0]).toMatchObject({
      event: { id: 'explicit-event' },
    });
  });

  it('leaves event_id null when nothing matches the triple', async () => {
    await service.createMany(ctx, [
      {
        type: 'Photo',
        source_type: 'import',
        source_system: 'facebook',
        source_id: 'photo-none',
      } as CreateContentDto,
    ]);

    expect(repo.create.mock.calls[0][0].event).toBeUndefined();
  });

  it('returns the existing row on triple conflict instead of inserting', async () => {
    repo.findOne.mockResolvedValueOnce({ id: 'content-existing', type: 'Photo' });

    const result = await service.createMany(ctx, [
      {
        type: 'Photo',
        source_type: 'import',
        source_system: 'facebook',
        source_id: 'photo-dupe',
      } as CreateContentDto,
    ]);

    expect(result[0].id).toBe('content-existing');
    expect(repo.create).not.toHaveBeenCalled();
  });
});
