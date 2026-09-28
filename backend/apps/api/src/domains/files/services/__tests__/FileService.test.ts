import { createHash } from 'crypto';

import { NotFoundException } from '@nestjs/common';

import { SYSTEM_USER, type UserServiceContext } from '@ci/common/context';

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

describe('FileService.create — a write a unique index refuses', () => {
  // At most one live PLAYBACK per original (files_one_playback_per_parent_uniq).
  // The bytes are PUT before the row, so a refused insert strands them unless
  // create() removes them — and a 23505 proves no row names that key.
  it('deletes the object it just put, then rethrows the violation', async () => {
    const repo = makeRepo();
    const violation = Object.assign(new Error('duplicate key value'), { code: '23505' });
    repo.save.mockRejectedValueOnce(violation);
    const { service, s3Send } = makeService(repo);

    await expect(
      service.create(ownerCtx, {
        buffer: Buffer.from('a rendition'),
        contentType: 'video/mp4',
        variant: FileVariant.PLAYBACK,
        parentId: 'parent-1',
      }),
    ).rejects.toBe(violation);

    const key = (repo.create.mock.results[0].value as { key: string }).key;

    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(s3Send.mock.calls[1][0].input).toMatchObject({ Delete: { Objects: [{ Key: key }] } });
  });

  // Any other failure may have committed the row after all (a connection lost
  // mid-commit); deleting its bytes then would leave a row naming nothing.
  it('keeps the object when the save failed for any other reason', async () => {
    const repo = makeRepo();
    repo.save.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const { service, s3Send } = makeService(repo);

    await expect(
      service.create(ownerCtx, {
        buffer: Buffer.from('a rendition'),
        contentType: 'video/mp4',
        variant: FileVariant.PLAYBACK,
        parentId: 'parent-1',
      }),
    ).rejects.toThrow('Connection terminated unexpectedly');
    expect(s3Send).toHaveBeenCalledTimes(1);
  });
});

describe('FileService.findVariantsOfKindsByParentIds', () => {
  it('fetches every kind in one query, each aligned with the parent ids and owner-scoped', async () => {
    const repo = makeRepo() as ReturnType<typeof makeRepo> & { find: jest.Mock };
    repo.find = jest.fn().mockResolvedValue([
      // The planner's order, not the caller's.
      { id: 'play-b', parentId: 'b', variant: FileVariant.PLAYBACK, bucket: null, key: null },
      { id: 'prev-a', parentId: 'a', variant: FileVariant.PREVIEW, bucket: null, key: null },
      { id: 'prev-b', parentId: 'b', variant: FileVariant.PREVIEW, bucket: null, key: null },
    ]);
    const { service } = makeService(repo);

    const byKind = await service.findVariantsOfKindsByParentIds(
      ownerCtx,
      ['a', 'b', 'c'],
      [FileVariant.PREVIEW, FileVariant.PLAYBACK],
    );

    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(repo.find.mock.calls[0][0].where).toMatchObject({ userId: 'owner-1' });
    expect(byKind[FileVariant.PREVIEW].map((file) => file?.id ?? null)).toEqual(['prev-a', 'prev-b', null]);
    expect(byKind[FileVariant.PLAYBACK].map((file) => file?.id ?? null)).toEqual([null, 'play-b', null]);
  });

  it('asks nothing for an empty page', async () => {
    const repo = makeRepo() as ReturnType<typeof makeRepo> & { find: jest.Mock };
    repo.find = jest.fn();
    const { service } = makeService(repo);

    await expect(
      service.findVariantsOfKindsByParentIds(ownerCtx, [], [FileVariant.PREVIEW, FileVariant.PLAYBACK]),
    ).resolves.toEqual({ [FileVariant.PREVIEW]: [], [FileVariant.PLAYBACK]: [] });
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('keeps the single-kind lookup’s shape', async () => {
    const repo = makeRepo() as ReturnType<typeof makeRepo> & { find: jest.Mock };
    repo.find = jest
      .fn()
      .mockResolvedValue([
        { id: 'prev-b', parentId: 'b', variant: FileVariant.PREVIEW, bucket: null, key: null },
      ]);
    const { service } = makeService(repo);

    const previews = await service.findVariantsByParentIds(ownerCtx, ['a', 'b'], FileVariant.PREVIEW);

    expect(previews.map((file) => file?.id ?? null)).toEqual([null, 'prev-b']);
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

describe('FileService.describedImageCoverage', () => {
  it('counts original images and how many carry a non-blank description, for the one user', async () => {
    const repo = makeRepo() as ReturnType<typeof makeRepo> & { query: jest.Mock };
    repo.query = jest.fn().mockResolvedValue([{ images: '22870', described: '5393' }]);
    const { service } = makeService(repo);

    const coverage = await service.describedImageCoverage(ownerCtx);

    expect(coverage).toEqual({ images: 22_870, described: 5_393 });

    const [sql, params] = repo.query.mock.calls[0];

    // ORIGINALs only — previews and thumbnails are derived copies of the same
    // picture — and a blank description is "not described", the same predicate
    // the description sweep uses to decide what is still owed one.
    expect(params).toEqual(['owner-1', 'ORIGINAL']);
    expect(sql).toContain("content_type LIKE 'image/%'");
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain("btrim(description) <> ''");
  });

  it('a user with no images is zero of zero, not NaN', async () => {
    const repo = makeRepo() as ReturnType<typeof makeRepo> & { query: jest.Mock };
    repo.query = jest.fn().mockResolvedValue([{ images: '0', described: '0' }]);

    expect(await makeService(repo).service.describedImageCoverage(ownerCtx)).toEqual({
      images: 0,
      described: 0,
    });
  });
});

describe('FileService by-key readers — getFileContent / getFileStream', () => {
  // Keys are minted UUIDs (`uuidv4()` in create); the column is `uuid`.
  const OWNED_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const stranger = { userId: 'someone-else' } as UserServiceContext;
  const system = { userId: SYSTEM_USER } as unknown as UserServiceContext;

  function makeReadable(bytes: string) {
    return {
      transformToByteArray: async () => new TextEncoder().encode(bytes),
      [Symbol.asyncIterator]: async function* () {
        yield new TextEncoder().encode(bytes);
      },
    };
  }

  it('serves the bytes to the account that owns the row pointing at the key', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ id: 'file-1' });
    const { service, s3Send } = makeService(repo);
    s3Send.mockResolvedValue({ Body: makeReadable('hello') });

    const bytes = await service.getFileContent(ownerCtx, OWNED_KEY);

    expect(Buffer.from(bytes).toString('utf8')).toBe('hello');
    // The lookup is by (key, owner) — and includes soft-deleted rows, because a
    // deleted row still names its owner and export reads deleted files too.
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: OWNED_KEY, userId: 'owner-1' }, withDeleted: true }),
    );
  });

  it('refuses another account, before the object store is ever asked', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const { service, s3Send } = makeService(repo);

    await expect(service.getFileContent(stranger, OWNED_KEY)).rejects.toThrow(NotFoundException);
    await expect(service.getFileStream(stranger, OWNED_KEY)).rejects.toThrow(NotFoundException);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('refuses a key that is not even UUID-shaped without touching the database', async () => {
    const repo = makeRepo();
    const { service, s3Send } = makeService(repo);

    await expect(service.getFileStream(ownerCtx, 'user-1/f1')).rejects.toThrow(NotFoundException);
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('exempts the system principal, like every other scoped lookup in this service', async () => {
    const repo = makeRepo();
    const { service, s3Send } = makeService(repo);
    s3Send.mockResolvedValue({ Body: makeReadable('x') });

    const stream = await service.getFileStream(system, OWNED_KEY);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }

    expect(Buffer.concat(chunks).toString('utf8')).toBe('x');
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
