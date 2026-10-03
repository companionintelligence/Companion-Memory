import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';

import type { LoggerService } from '@ci/common/logging';
import { EventListenerRegistry, LocalEventService, type Acknowledgement } from '@ci/domains/events';
import { FileUploadedEvent, type FileUploadedPayload } from '@ci/domains/files';

import { FileService, LEGACY_FILE_ENTITY_QUEUE, MEMORY_FILE_ENTITY_QUEUE } from '../FileService';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// None of these tests set captureTickId on the file fixture, so
// linkCaptureEvent short-circuits before ever touching this repository —
// it only needs to satisfy the constructor injection.
function eventRepoMock() {
  return { findOne: jest.fn() };
}

function repoMock() {
  const repo = {
    findOne: jest.fn(),
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: { id?: string }) => ({ ...x, id: x.id ?? 'inserted' })),
    // findOrCreateForFile writes inside a transaction; the transactional
    // manager hands back this same mock repository.
    manager: {
      transaction: jest.fn(async (cb: (m: { getRepository: () => unknown }) => unknown) =>
        cb({ getRepository: (): unknown => repo }),
      ),
    },
  };

  return repo;
}

function payload(overrides: Partial<FileUploadedPayload> = {}): FileUploadedPayload {
  return {
    fileId: 'file-1',
    userId: 'user-1',
    thingCapture: false,
    ...overrides,
  };
}

function ackMock(): Acknowledgement {
  return { jobId: 'test-job', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

// @OnEvent's autoAcknowledge wrapper never rethrows: handleFileUploaded is
// called with an explicit ack so success vs. failure is observable via
// ack.done()/ack.fail() rather than promise rejection.
function callWithAck(service: FileService, p: FileUploadedPayload, ack: Acknowledgement) {
  return (
    service as unknown as {
      handleFileUploaded: (payload: FileUploadedPayload, ack: Acknowledgement) => Promise<void>;
    }
  ).handleFileUploaded(p, ack);
}

describe('FileService.handleFileUploaded', () => {
  let repo: ReturnType<typeof repoMock>;
  let fileStorageService: { findById: jest.Mock };
  let logger: ReturnType<typeof makeLogger>;
  let service: FileService;

  beforeEach(() => {
    repo = repoMock();
    fileStorageService = { findById: jest.fn() };
    logger = makeLogger();
    service = new FileService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fileStorageService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventRepoMock() as any,
      // Nothing here removes a file, so nothing is announced.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
    );
  });

  it('skips entity creation when the ci.files row is not found', async () => {
    fileStorageService.findById.mockResolvedValue(null);

    await service.handleFileUploaded(payload());

    expect(repo.save).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'File not found, skipping entity creation',
      expect.objectContaining({ fileId: 'file-1' }),
    );
  });

  it('creates a graph File entity linked to the ci.files row', async () => {
    fileStorageService.findById.mockResolvedValue({ id: 'file-1', filename: 'photo.jpg' });
    repo.findOne.mockResolvedValue(null);

    await service.handleFileUploaded(payload({ userId: 'user-1' }));

    expect(fileStorageService.findById).toHaveBeenCalledWith({ userId: 'user-1' }, 'file-1');
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'photo.jpg',
        linkedTable: 'files',
        linkedId: 'file-1',
        userId: 'user-1',
      }),
    );
  });

  it('is idempotent when a graph entity already exists for the file (re-fired event)', async () => {
    fileStorageService.findById.mockResolvedValue({ id: 'file-1', filename: 'photo.jpg' });
    repo.findOne.mockResolvedValue({ id: 'existing-entity', linkedTable: 'files', linkedId: 'file-1' });

    await service.handleFileUploaded(payload());

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('looks up the existing row scoped to entity_type File via linkedTable/linkedId', async () => {
    fileStorageService.findById.mockResolvedValue({ id: 'file-1', filename: 'photo.jpg' });
    repo.findOne.mockResolvedValue(null);

    await service.handleFileUploaded(payload());

    expect(repo.findOne.mock.calls[0][0].where).toMatchObject({
      linkedTable: 'files',
      linkedId: 'file-1',
    });
  });

  // The pre-fix code had no guard here at all: two concurrent
  // findOrCreateForFile calls for the same file id (e.g. a re-fired
  // FileUploadedEvent racing the original) both pass the initial findOne,
  // both insert, and the loser's unique-constraint violation (23505 on
  // entities_linked_uniq) propagated straight out of handleFileUploaded.
  it('recovers from a concurrent-duplicate race by returning the winner instead of failing the job', async () => {
    fileStorageService.findById.mockResolvedValue({ id: 'file-1', filename: 'photo.jpg' });
    const winner = { id: 'winner-entity', linkedTable: 'files', linkedId: 'file-1' };
    repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    repo.manager.transaction.mockRejectedValueOnce({ code: '23505' });
    const ack = ackMock();

    await callWithAck(service, payload(), ack);

    expect(repo.findOne).toHaveBeenCalledTimes(2);
    expect(ack.done).toHaveBeenCalledTimes(1);
    expect(ack.fail).not.toHaveBeenCalled();
  });

  it('fails the job on a non-duplicate transaction error', async () => {
    fileStorageService.findById.mockResolvedValue({ id: 'file-1', filename: 'photo.jpg' });
    repo.findOne.mockResolvedValue(null);
    repo.manager.transaction.mockRejectedValueOnce(new Error('connection reset'));
    const ack = ackMock();

    await callWithAck(service, payload(), ack);

    expect(ack.fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection reset' }));
    expect(ack.done).not.toHaveBeenCalled();
  });
});

/**
 * The handler moved off the shared `default` queue onto its own. Jobs are
 * durable, so the queue it USED to be on still has to be worked or the
 * `file.uploaded` jobs sitting in `created` across the deploy are fetched,
 * matched against nothing and completed — leaving those files with no graph
 * File node, which nothing else ever mints.
 *
 * Dispatch is driven through the real machinery rather than by calling the
 * methods: `@nestjs/event-emitter`'s own subscriber loader binds whatever the
 * decorators declared, and `LocalEventService` picks the target queues from
 * the listener registry and emits `${event}:${queue}` exactly as
 * `PGBossEventService.executeJob` does. A hand-called method would pass with
 * or without the queue registration, which is the whole failure mode here.
 */
describe('file.uploaded queue bindings', () => {
  let repo: ReturnType<typeof repoMock>;
  let fileStorageService: { findById: jest.Mock };
  let logger: ReturnType<typeof makeLogger>;
  let moduleRef: TestingModule;
  let events: LocalEventService;

  beforeEach(async () => {
    repo = repoMock();
    repo.findOne.mockResolvedValue(null);
    fileStorageService = { findById: jest.fn().mockResolvedValue({ id: 'file-1', filename: 'photo.jpg' }) };
    logger = makeLogger();

    // Registered by instance so the loader subscribes the decorated methods
    // without this test having to satisfy FileService's constructor injection.
    const service = new FileService(
      fileStorageService as never,
      repo as never,
      eventRepoMock() as never,
      // Nothing here removes a file, so nothing is announced.
      {} as never,
      logger as unknown as LoggerService,
    );

    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [{ provide: FileService, useValue: service }],
    }).compile();

    await moduleRef.init();

    events = new LocalEventService(moduleRef.get(EventEmitter2), logger as unknown as LoggerService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('declares both the dedicated queue and the pre-split default queue', () => {
    expect([...EventListenerRegistry.getQueuesFor(FileUploadedEvent)]).toEqual(
      expect.arrayContaining([MEMORY_FILE_ENTITY_QUEUE, LEGACY_FILE_ENTITY_QUEUE]),
    );
  });

  it('creates the graph File entity for a job dispatched on the dedicated queue', async () => {
    await events.send(FileUploadedEvent, payload(), { queue: MEMORY_FILE_ENTITY_QUEUE });

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ linkedTable: 'files', linkedId: 'file-1', userId: 'user-1' }),
    );
  });

  it('still creates the graph File entity for a job left on the default queue by the previous build', async () => {
    await events.send(FileUploadedEvent, payload(), { queue: LEGACY_FILE_ENTITY_QUEUE });

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ linkedTable: 'files', linkedId: 'file-1', userId: 'user-1' }),
    );
  });
});
