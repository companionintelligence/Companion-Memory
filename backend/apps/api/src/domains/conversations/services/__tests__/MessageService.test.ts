import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';

import { MessageEntity } from '../../entities/MessageEntity';
import { MessageDeletedEvent } from '../../events';
import { MessageService } from '../MessageService';

const ctx = { userId: SYSTEM_USER } as ServiceContext;

describe('MessageService — threadId on MessageDeletedEvent', () => {
  let service: MessageService;
  let repo: { findOne: jest.Mock; delete: jest.Mock; update: jest.Mock };
  let events: { send: jest.Mock };

  async function setup(existing: Partial<MessageEntity> | null) {
    repo = {
      findOne: jest.fn(async () => existing),
      delete: jest.fn(async () => ({ affected: 1 })),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    events = { send: jest.fn(async () => []) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: getRepositoryToken(MessageEntity), useValue: repo },
        { provide: FileService, useValue: {} },
        { provide: EventService, useValue: events },
      ],
    }).compile();

    service = moduleRef.get(MessageService);
  }

  // Without the fix, remove()/softRemove() sent only { messageId }, so the
  // search-index listener had no way to learn which thread to re-index once
  // the message was gone (findById filters canceled: false and returns null
  // for both a hard and a soft delete).
  it("remove() carries the deleted message's threadId on the event, fetched before the row is gone", async () => {
    await setup({ id: 'msg-1', threadId: 'thread-1' } as MessageEntity);

    await service.remove(ctx, 'msg-1');

    expect(repo.findOne.mock.invocationCallOrder[0]).toBeLessThan(repo.delete.mock.invocationCallOrder[0]);
    expect(events.send).toHaveBeenCalledWith(MessageDeletedEvent, {
      messageId: 'msg-1',
      threadId: 'thread-1',
    });
  });

  it("softRemove() carries the canceled message's threadId on the event", async () => {
    await setup({ id: 'msg-2', threadId: 'thread-2' } as MessageEntity);

    await service.softRemove(ctx, 'msg-2');

    expect(events.send).toHaveBeenCalledWith(MessageDeletedEvent, {
      messageId: 'msg-2',
      threadId: 'thread-2',
    });
  });

  it('emits a null threadId when the message has none, instead of dropping the field', async () => {
    await setup({ id: 'msg-3', threadId: undefined } as MessageEntity);

    await service.remove(ctx, 'msg-3');

    expect(events.send).toHaveBeenCalledWith(MessageDeletedEvent, {
      messageId: 'msg-3',
      threadId: null,
    });
  });
});
