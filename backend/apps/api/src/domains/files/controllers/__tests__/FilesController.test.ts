import { type RequestContext } from '@ci/common/context';

import { FilesController } from '../FilesController';

/**
 * FilesController.upload does its own in-batch dedup grouping ahead of
 * FileService.uploadWithDedupInfo's own hash-vs-store check — collapsing
 * repeated content within a single multipart request into one upload call.
 * BulkFilesRoutes.e2e.test.ts and Routes.e2e.test.ts both stub
 * FileService.upload/getFileHash entirely, so neither exercises this grouping
 * logic; it has never run against real inputs.
 *
 * Contrast with BulkFilesController, which keys within-batch dedup by hash
 * ONLY and always falls through to a real upload call when hash is null
 * (untested-but-safe). FilesController's fallback key for a hashless file —
 * `file.originalname + Date.now()` — is a Map key, so two hashless files with
 * the same name uploaded inside the same millisecond collide and the second
 * silently never reaches FileService.upload.
 */

const ctx = { userId: 'owner-1' } as RequestContext;

function multerFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    originalname: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: 100,
    buffer: Buffer.from('bytes'),
    ...overrides,
  } as Express.Multer.File;
}

function makeController() {
  const fileService = {
    getFileHash: jest.fn(),
    upload: jest.fn(),
  };

  return { controller: new FilesController(fileService as never), fileService };
}

describe('FilesController.upload — in-batch dedup grouping', () => {
  it('uploads each file with a distinct hash exactly once, one response entry per unique hash', async () => {
    const { controller, fileService } = makeController();
    fileService.getFileHash.mockResolvedValueOnce('hash-a').mockResolvedValueOnce('hash-b');
    fileService.upload.mockResolvedValueOnce({ id: 'id-a' }).mockResolvedValueOnce({ id: 'id-b' });

    const result = await controller.upload(ctx, [
      multerFile({ originalname: 'a.jpg' }),
      multerFile({ originalname: 'b.jpg' }),
    ]);

    expect(fileService.upload).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ id: 'id-a' }, { id: 'id-b' }]);
  });

  it('collapses two files that hash identically into a single upload call', async () => {
    const { controller, fileService } = makeController();
    fileService.getFileHash.mockResolvedValue('same-hash');
    fileService.upload.mockResolvedValue({ id: 'id-1' });

    const result = await controller.upload(ctx, [
      multerFile({ originalname: 'a.jpg' }),
      multerFile({ originalname: 'a-copy.jpg' }),
    ]);

    expect(fileService.upload).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 'id-1' }]);
  });

  it('two distinct hashless files with the same name in the same millisecond collide and one is silently dropped', async () => {
    // Documents a real, currently-uncaught defect (flagged by the backend
    // test audit): the no-hash fallback key `originalname + Date.now()` is
    // not unique per input, only per (name, millisecond). Freeze Date.now()
    // to make the collision deterministic instead of a timing-dependent
    // flake — production is exposed to exactly this whenever two hashless
    // uploads land in the same request and millisecond.
    const { controller, fileService } = makeController();
    fileService.getFileHash.mockResolvedValue(null);
    fileService.upload.mockResolvedValue({ id: 'id-1' });
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    try {
      const result = await controller.upload(ctx, [
        multerFile({ originalname: 'IMG_0001.jpg', buffer: undefined, path: undefined }),
        multerFile({ originalname: 'IMG_0001.jpg', buffer: undefined, path: undefined }),
      ]);

      // The caller sent 2 files; only 1 ever reaches FileService.upload and
      // only 1 id comes back — with no error surfaced anywhere indicating a
      // file was dropped.
      expect(fileService.upload).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not collide two hashless files with different names in the same millisecond', async () => {
    const { controller, fileService } = makeController();
    fileService.getFileHash.mockResolvedValue(null);
    fileService.upload.mockResolvedValueOnce({ id: 'id-a' }).mockResolvedValueOnce({ id: 'id-b' });
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    try {
      const result = await controller.upload(ctx, [
        multerFile({ originalname: 'a.jpg', buffer: undefined, path: undefined }),
        multerFile({ originalname: 'b.jpg', buffer: undefined, path: undefined }),
      ]);

      expect(fileService.upload).toHaveBeenCalledTimes(2);
      expect(result).toEqual([{ id: 'id-a' }, { id: 'id-b' }]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects an empty file list', async () => {
    const { controller } = makeController();

    await expect(controller.upload(ctx, [])).rejects.toThrow('At least one file is required');
  });

  it('passes thingCapture/skipDescription/model through to FileService.upload', async () => {
    const { controller, fileService } = makeController();
    fileService.getFileHash.mockResolvedValue('hash-a');
    fileService.upload.mockResolvedValue({ id: 'id-a' });

    await controller.upload(ctx, [multerFile()], 'true', undefined, 'true', ' gemma4:e4b ');

    expect(fileService.upload).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({
        thingCapture: true,
        skipDescription: true,
        model: 'gemma4:e4b',
      }),
    );
  });

  // The retired inventory feature's form field. Capture clients live in other
  // repos, so the old spelling still has to reach the same flag — a silently
  // ignored field would turn thing capture into a plain upload with no error.
  it('still honours the deprecated inventoryCapture form field', async () => {
    const { controller, fileService } = makeController();
    fileService.getFileHash.mockResolvedValue('hash-a');
    fileService.upload.mockResolvedValue({ id: 'id-a' });

    await controller.upload(ctx, [multerFile()], undefined, 'true');

    expect(fileService.upload).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({ thingCapture: true }),
    );
  });
});
