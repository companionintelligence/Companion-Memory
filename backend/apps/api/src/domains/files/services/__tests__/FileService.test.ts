import { createHash } from 'crypto';

import { type UserServiceContext } from '@ci/common/context';

import { FileUploadedEvent } from '../../events';
import { FileVariant } from '../../types';
import { FileService } from '../FileService';

/**
 * Unit tests for the sha256-hash-based file dedup pipeline: the load-bearing
 * idempotency mechanism that stops a re-upload of the same bytes (a re-import,
 * a retried capture) from creating a second `ci.files` row and a second S3
 * object. Prior to this file the only exercise of `create` /
 * `uploadWithDedupInfo` / `getFileHash` / `findByHash` was through fakes that
 * hard-coded the outcome (BulkFilesRoutes.e2e.test.ts) or stubbed the whole
 * service out (Routes.e2e.test.ts) — neither can catch a bug in the real
 * hash-then-lookup-then-create sequence.
 *
 * The repository is an in-memory jest mock (same pattern as
 * SavedSearchService.test.ts); the S3 client is a private field on FileService
 * so it's swapped out post-construction rather than injected.
 */

const ownerCtx = { userId: 'owner-1' } as UserServiceContext;

function makeRepo() {
  return {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => ({
      ...row,
      createdAt: new Date('2026-08-18T00:00:00Z'),
      updatedAt: new Date('2026-08-18T00:00:00Z'),
    })),
    findOne: jest.fn(),
  };
}

function makeService(repo: ReturnType<typeof makeRepo>) {
  const eventService = { send: jest.fn() };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const service = new FileService(repo as never, eventService as never, logger as never);

  // The S3 clients are constructed inline (`new S3Client(...)`) rather than
  // injected, so a real create() with a buffer would otherwise attempt a real
  // network PutObject. Swap the send method only — signFile's getSignedUrl
  // call is a pure SigV4 computation and needs no stub.
  (service as unknown as { s3: { send: jest.Mock } }).s3 = { send: jest.fn().mockResolvedValue({}) };

  return { service, repo, eventService, s3Send: (service as unknown as { s3: { send: jest.Mock } }).s3.send };
}

describe('FileService.getFileHash', () => {
  it('hashes a buffer with sha256', async () => {
    const { service } = makeService(makeRepo());

    const hash = await service.getFileHash({ buffer: Buffer.from('hello world') });

    expect(hash).toHaveLength(64);
    expect(hash).toBe(createHash('sha256').update(Buffer.from('hello world')).digest('hex'));
  });

  it('returns null when neither buffer nor path is provided', async () => {
    const { service } = makeService(makeRepo());

    await expect(service.getFileHash({})).resolves.toBeNull();
  });

  it('produces the same hash for identical bytes (the dedup precondition)', async () => {
    const { service } = makeService(makeRepo());

    const a = await service.getFileHash({ buffer: Buffer.from('same content') });
    const b = await service.getFileHash({ buffer: Buffer.from('same content') });

    expect(a).toEqual(b);
  });

  it('produces different hashes for different bytes', async () => {
    const { service } = makeService(makeRepo());

    const a = await service.getFileHash({ buffer: Buffer.from('content A') });
    const b = await service.getFileHash({ buffer: Buffer.from('content B') });

    expect(a).not.toEqual(b);
  });
});

describe('FileService.findByHash', () => {
  it('scopes the lookup to the calling user', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    await service.findByHash(ownerCtx, 'abc123');

    expect(repo.findOne).toHaveBeenCalledWith({ where: { hash: 'abc123', userId: 'owner-1' } });
  });

  it('returns null when nothing matches', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const { service } = makeService(repo);

    await expect(service.findByHash(ownerCtx, 'missing')).resolves.toBeNull();
  });
});

describe('FileService.create — hash dedup', () => {
  it('returns the existing row and never touches S3 or repo.save when the hash already exists', async () => {
    const repo = makeRepo();
    const existing = {
      id: 'existing-id',
      userId: 'owner-1',
      hash: 'dupe-hash',
      bucket: null,
      key: null,
      externalId: 'ext-1',
    };
    repo.findOne.mockResolvedValue(existing);
    const { service, s3Send } = makeService(repo);

    const result = await service.create(ownerCtx, { buffer: Buffer.from('duplicate bytes') });

    expect(result.id).toBe('existing-id');
    expect(repo.save).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('creates a new row and uploads to S3 when the hash has no match', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const { service, s3Send } = makeService(repo);

    const result = await service.create(ownerCtx, {
      buffer: Buffer.from('brand new bytes'),
      filename: 'note.txt',
      contentType: 'text/plain',
    });

    expect(repo.save).toHaveBeenCalledTimes(1);
    const savedRow = repo.save.mock.calls[0][0] as Record<string, unknown>;
    expect(savedRow.userId).toBe('owner-1');
    expect(savedRow.hash).toEqual(createHash('sha256').update(Buffer.from('brand new bytes')).digest('hex'));
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(result.id).toBe(savedRow.id);
  });

  it('does NOT dedup a PREVIEW variant against another parent’s identical preview', async () => {
    // Two videos that are re-uploads of the same footage render byte-identical
    // 300px frames. Deduping the second preview onto the first left the second
    // parent with no PREVIEW row at all — the explorer then drew nothing (or
    // the raw .mp4) for it. A derived variant belongs to its parent; identical
    // bytes across parents are two rows.
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ id: 'other-parents-preview', userId: 'owner-1', hash: 'same-frame' });
    const { service, s3Send } = makeService(repo);

    const result = await service.create(ownerCtx, {
      buffer: Buffer.from('identical preview bytes'),
      contentType: 'image/jpeg',
      variant: FileVariant.PREVIEW,
      parentId: 'parent-2',
    });

    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(result.id).not.toBe('other-parents-preview');
    expect((repo.save.mock.calls[0][0] as Record<string, unknown>).parentId).toBe('parent-2');
  });

  it('dedups by externalId before ever computing a hash', async () => {
    const repo = makeRepo();
    const existing = {
      id: 'existing-external',
      userId: 'owner-1',
      externalId: 'ext-42',
      bucket: null,
      key: null,
    };
    repo.findOne.mockResolvedValue(existing);
    const { service, s3Send } = makeService(repo);

    const result = await service.create(ownerCtx, {
      externalId: 'ext-42',
      buffer: Buffer.from('irrelevant'),
    });

    expect(result.id).toBe('existing-external');
    expect(repo.save).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });
});

describe('FileService.uploadWithDedupInfo', () => {
  it('reports deduped:true and skips create() when the hash already exists', async () => {
    const repo = makeRepo();
    const existing = { id: 'existing-id', userId: 'owner-1', hash: 'dupe-hash', bucket: null, key: null };
    repo.findOne.mockResolvedValue(existing);
    const { service, eventService, s3Send } = makeService(repo);

    const result = await service.uploadWithDedupInfo(ownerCtx, {
      buffer: Buffer.from('duplicate bytes'),
      filename: 'dup.txt',
    });

    expect(result).toEqual({ file: expect.objectContaining({ id: 'existing-id' }), deduped: true });
    expect(repo.save).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
    // Not a thing capture, so the dedup hit is silent — no event fan-out
    // for content the pipeline has already processed once.
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('still notifies on a dedup hit when thingCapture is set', async () => {
    const repo = makeRepo();
    const existing = { id: 'existing-id', userId: 'owner-1', hash: 'dupe-hash', bucket: null, key: null };
    repo.findOne.mockResolvedValue(existing);
    const { service, eventService } = makeService(repo);

    await service.uploadWithDedupInfo(ownerCtx, {
      buffer: Buffer.from('duplicate bytes'),
      filename: 'dup.txt',
      thingCapture: true,
    });

    expect(eventService.send).toHaveBeenCalledWith(FileUploadedEvent, {
      fileId: 'existing-id',
      userId: 'owner-1',
      thingCapture: true,
      skipDescription: false,
      model: undefined,
    });
  });

  it('creates a new ORIGINAL file and fires FileUploadedEvent with deduped:false semantics when there is no match', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const { service, eventService } = makeService(repo);

    const result = await service.uploadWithDedupInfo(ownerCtx, {
      buffer: Buffer.from('brand new bytes'),
      filename: 'new.txt',
      thingCapture: false,
      skipDescription: true,
    });

    expect(result.deduped).toBe(false);
    const savedRow = repo.save.mock.calls[0][0] as Record<string, unknown>;
    expect(savedRow.variant).toBe(FileVariant.ORIGINAL);
    expect(eventService.send).toHaveBeenCalledWith(FileUploadedEvent, {
      fileId: result.file.id,
      userId: 'owner-1',
      thingCapture: false,
      skipDescription: true,
      model: undefined,
    });
  });
});
