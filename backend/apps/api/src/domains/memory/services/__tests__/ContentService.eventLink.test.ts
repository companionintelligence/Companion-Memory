import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { ContentEntity } from '../../entities/ContentEntity';
import type { CreateContentDto } from '../../types';
import { ContentService } from '../ContentService';

describe('ContentService.create — event link', () => {
  let service: ContentService;
  let repo: { create: jest.Mock; save: jest.Mock };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  beforeEach(async () => {
    repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: { id?: string }) => ({ ...x, id: x.id ?? 'content-1' })),
    };
    const mod = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
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
      user: { id: 'user-1' },
    });
  });

  it('omits the event relation when no event is given', async () => {
    await service.create(ctx, { type: 'note', text: 'hi' } as CreateContentDto);
    expect(repo.create.mock.calls[0][0].event).toBeUndefined();
  });
});
