import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { FileRemovedEvent } from '@ci/domains/files/events';
import { ContentRemovedEvent } from '@ci/domains/memory/events';

import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventEntity } from '../../entities/EventEntity';
import { purgeContentAggregates, purgeFilesWrappedBy } from '../contentPurge';
import { ContentService } from '../ContentService';
import { drainStoredObjectDeletes } from '../filePurge';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { nothingWrapped } from '../wrappedFilePurge';

/**
 * What `remove` and `purge` do once their transaction has committed. The delete has happened by
 * then, so a failure after it must not fail the call: a caller told otherwise would retry something
 * that is done. The purge helpers are stubbed; what they delete is the integration suites' to check,
 * in Postgres.
 */
jest.mock('../contentPurge', () => ({
  ...jest.requireActual('../contentPurge'),
  purgeContentAggregates: jest.fn(),
  purgeFilesWrappedBy: jest.fn(),
}));

jest.mock('../filePurge', () => ({
  ...jest.requireActual('../filePurge'),
  drainStoredObjectDeletes: jest.fn(),
}));

const owner = { userId: 'user-1' } as UserServiceContext;

describe('ContentService work after the commit', () => {
  let service: ContentService;
  let send: jest.Mock;
  let logged: jest.SpyInstance;

  beforeEach(async () => {
    const detail = Object.assign(new ContentEntity(), { id: 'c1', userId: 'user-1', type: 'media' });
    const repo = {
      findOne: jest.fn(async () => detail),
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown =>
              cls === ContentBaseEntity
                ? { findOne: jest.fn(async () => ({ id: 'c1', name: 'IMG_0001.jpg' })), delete: jest.fn() }
                : { findOne: jest.fn(async () => detail) },
          }),
        ),
      },
    };

    send = jest.fn(async () => []);
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
        { provide: getRepositoryToken(ContentBaseEntity), useValue: {} },
        { provide: getRepositoryToken(EventEntity), useValue: {} },
        { provide: SignallingEventService, useValue: { send } },
        { provide: GraphDeltaWriter, useValue: { entityDeleted: jest.fn(async () => undefined) } },
      ],
    }).compile();

    service = moduleRef.get(ContentService);
  });

  afterEach(() => {
    logged.mockRestore();
    jest.mocked(drainStoredObjectDeletes).mockReset();
    jest.mocked(purgeFilesWrappedBy).mockReset();
    jest.mocked(purgeContentAggregates).mockReset();
  });

  it('answers a committed delete as done when its stored objects cannot be drained, and still announces it', async () => {
    jest.mocked(purgeFilesWrappedBy).mockResolvedValue({
      files: { ...nothingWrapped(), fileIds: ['f1'] },
      queuedObjectIds: ['obj-1'],
    });
    jest.mocked(drainStoredObjectDeletes).mockRejectedValue(new Error('connection lost'));

    await expect(service.remove(owner, 'c1')).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(ContentRemovedEvent, { contentId: 'c1' });
    expect(send).toHaveBeenCalledWith(FileRemovedEvent, { fileId: 'f1' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('stay queued for the retry sweep');
  });

  it('returns a committed purge when its stored objects cannot be drained, and still announces it', async () => {
    const purged = {
      contentIds: ['c1'],
      files: { ...nothingWrapped(), fileIds: ['f1'] },
      queuedObjectIds: ['obj-1'],
    };

    jest.mocked(purgeContentAggregates).mockResolvedValue(purged);
    jest.mocked(drainStoredObjectDeletes).mockRejectedValue(new Error('connection lost'));

    await expect(service.purge(owner, ['c1'])).resolves.toEqual(purged);

    expect(send).toHaveBeenCalledWith(ContentRemovedEvent, { contentId: 'c1' });
    expect(send).toHaveBeenCalledWith(FileRemovedEvent, { fileId: 'f1' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('stay queued for the retry sweep');
  });

  it('answers a committed delete as done when an announcement fails, and still sends the rest', async () => {
    jest.mocked(purgeFilesWrappedBy).mockResolvedValue({
      files: { ...nothingWrapped(), fileIds: ['f1', 'f2'] },
      queuedObjectIds: [],
    });
    send.mockImplementation(async (event: unknown) => {
      if (event === ContentRemovedEvent) {
        throw new Error('pg-boss is not started');
      }

      return [];
    });

    await expect(service.remove(owner, 'c1')).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(FileRemovedEvent, { fileId: 'f1' });
    expect(send).toHaveBeenCalledWith(FileRemovedEvent, { fileId: 'f2' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('pg-boss is not started');
  });

  it('returns a committed purge as done when one announcement fails, and still sends the rest', async () => {
    const purged = {
      contentIds: ['c1', 'c2'],
      files: { ...nothingWrapped(), fileIds: ['f1'] },
      queuedObjectIds: [],
    };

    jest.mocked(purgeContentAggregates).mockResolvedValue(purged);
    send.mockImplementation(async (event: unknown, payload: unknown) => {
      if (event === ContentRemovedEvent && (payload as { contentId: string }).contentId === 'c1') {
        throw new Error('pg-boss is not started');
      }

      return [];
    });

    await expect(service.purge(owner, ['c1', 'c2'])).resolves.toEqual(purged);

    expect(send).toHaveBeenCalledWith(ContentRemovedEvent, { contentId: 'c2' });
    expect(send).toHaveBeenCalledWith(FileRemovedEvent, { fileId: 'f1' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('{"contentId":"c1"}');
  });

  it('sends each file announcement on its own, so one that fails does not stop the others', async () => {
    jest.mocked(purgeFilesWrappedBy).mockResolvedValue({
      files: { ...nothingWrapped(), fileIds: ['f1', 'f2', 'f3'] },
      queuedObjectIds: [],
    });
    send.mockImplementation(async (event: unknown, payload: unknown) => {
      if (event === FileRemovedEvent && (payload as { fileId: string }).fileId === 'f2') {
        throw new Error('pg-boss is not started');
      }

      return [];
    });

    await expect(service.remove(owner, 'c1')).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(FileRemovedEvent, { fileId: 'f1' });
    expect(send).toHaveBeenCalledWith(FileRemovedEvent, { fileId: 'f2' });
    expect(send).toHaveBeenCalledWith(FileRemovedEvent, { fileId: 'f3' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('{"fileId":"f2"}');
  });
});
