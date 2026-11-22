import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import config from '@ci/configuration';

import { ImportUploadsController } from '../ImportUploadsController';

/**
 * Intake behaviour worth pinning down:
 *  - the file sits at its FINAL `<uploadsDir>/<dropId>/` path before the
 *    registry hears about it, so the registry never advertises bytes that are
 *    not there;
 *  - the incoming copy is gone on BOTH paths — renamed away on success,
 *    unlinked on failure. An aborted upload that leaves its incoming file
 *    fills the disk, and these files are multi-GB;
 *  - a `../`-bearing client filename cannot escape the upload's own
 *    directory: `originalname` is attacker-controlled text landing on a real
 *    filesystem.
 */

const ctx = { userId: 'user-1' } as RequestContext;

let uploadsDir: string;
let previousUploadsDir: string;

beforeEach(() => {
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uploads-ctl-'));
  previousUploadsDir = config.import.uploadsDir;
  (config.import as { uploadsDir: string }).uploadsDir = uploadsDir;
  fs.mkdirSync(path.join(uploadsDir, 'incoming'), { recursive: true });
});

afterEach(() => {
  (config.import as { uploadsDir: string }).uploadsDir = previousUploadsDir;
});

function incomingUpload(name: string, contents = 'zip bytes'): Express.Multer.File {
  const filePath = path.join(uploadsDir, 'incoming', `${Math.random().toString(36).slice(2)}`);

  fs.writeFileSync(filePath, contents);

  return {
    originalname: name,
    mimetype: 'application/zip',
    size: Buffer.byteLength(contents),
    path: filePath,
  } as Express.Multer.File;
}

function makeController() {
  const order: string[] = [];

  const sources = {
    registerUpload: jest.fn(
      async (_ctx: unknown, input: { dropId: string; sourcePath: string; sizeBytes?: number | null }) => {
        // The ordering contract, checked at the only moment it can be: the
        // staged file must already sit at its final path when the registry
        // first hears about it.
        order.push(fs.existsSync(input.sourcePath) ? `register:present` : `register:MISSING`);

        return {
          dropId: input.dropId,
          originalFilename: 'export.zip',
          sizeBytes: input.sizeBytes ?? null,
          status: 'staged',
          expiresAt: new Date('2026-08-15T00:00:00Z'),
        };
      },
    ),
    listStagedUploads: jest.fn(async () => []),
    releaseUpload: jest.fn(async () => true),
  };

  return { controller: new ImportUploadsController(sources as never), sources, order };
}

describe('ImportUploadsController.upload', () => {
  it('stages the file at its final path before registering it', async () => {
    const { controller, order } = makeController();
    const file = incomingUpload('export.zip');

    const staged = await controller.upload(ctx, [file]);

    expect(staged).toHaveLength(1);
    expect(staged[0].status).toBe('staged');
    expect(order).toEqual(['register:present']);
    // The incoming copy was renamed away, not left behind.
    expect(fs.existsSync(file.path)).toBe(false);
    // And the staged copy lives under <uploadsDir>/<dropId>/.
    expect(fs.readdirSync(uploadsDir).filter((name) => name !== 'incoming')).toHaveLength(1);
  });

  it('contains a traversal-bearing filename inside the upload directory', async () => {
    const { controller, sources } = makeController();
    const file = incomingUpload('../../etc/passwd');

    await controller.upload(ctx, [file]);

    const sourcePath = sources.registerUpload.mock.calls[0][1].sourcePath as string;

    // Sanitized into the drop dir — never resolved upward out of it.
    expect(path.relative(uploadsDir, sourcePath).startsWith('..')).toBe(false);
    expect(sourcePath).not.toContain('..');
    expect(fs.existsSync(path.resolve(uploadsDir, '../etc/passwd'))).toBe(false);
  });

  it('stages the remaining files when one registration fails, and unlinks the failed incoming copy', async () => {
    const { controller, sources } = makeController();

    sources.registerUpload.mockRejectedValueOnce(new Error('registry down'));

    const failed = incomingUpload('a.zip');
    const survivor = incomingUpload('b.zip');

    await expect(controller.upload(ctx, [failed, survivor])).rejects.toThrow('registry down');

    // Both incoming copies are gone: a.zip was renamed before its registration
    // failed (the orphan sweep owns that stranded drop dir), b.zip never staged
    // and its incoming copy was unlinked by the finally.
    expect(fs.existsSync(failed.path)).toBe(false);
    expect(fs.existsSync(survivor.path)).toBe(false);
  });

  it('stages a folder as one directory drop when relative paths are sent', async () => {
    const { controller, sources } = makeController();
    const conversations = incomingUpload('conversations.json', '{"mapping":{}}');
    const html = incomingUpload('chat.html', '<html></html>');

    const staged = await controller.upload(ctx, [conversations, html], {
      paths: ['chatgpt-export/conversations.json', 'chatgpt-export/chat.html'],
    });

    expect(staged).toHaveLength(1);
    expect(sources.registerUpload).toHaveBeenCalledTimes(1);
    expect(sources.registerUpload.mock.calls[0][1]).toMatchObject({
      kind: 'directory',
      originalFilename: 'chatgpt-export',
    });

    const sourcePath = sources.registerUpload.mock.calls[0][1].sourcePath as string;

    expect(fs.statSync(sourcePath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(sourcePath, 'conversations.json'), 'utf8')).toBe('{"mapping":{}}');
    expect(fs.readFileSync(path.join(sourcePath, 'chat.html'), 'utf8')).toBe('<html></html>');
  });

  it('keeps the name a loose export file is recognized by', async () => {
    const { controller, sources } = makeController();

    await controller.upload(ctx, [incomingUpload('My Clippings.txt', '==========')]);

    const sourcePath = sources.registerUpload.mock.calls[0][1].sourcePath as string;

    expect(path.basename(sourcePath)).toBe('My Clippings.txt');
    expect(path.dirname(path.dirname(sourcePath))).toBe(uploadsDir);
  });

  it('keeps folder and file names with spaces in a folder upload', async () => {
    const { controller, sources } = makeController();

    await controller.upload(ctx, [incomingUpload('Saved Places.json', '{}')], {
      paths: ['Takeout/Maps (your places)/Saved Places.json'],
    });

    const sourcePath = sources.registerUpload.mock.calls[0][1].sourcePath as string;

    expect(fs.readFileSync(path.join(sourcePath, 'Maps (your places)', 'Saved Places.json'), 'utf8')).toBe(
      '{}',
    );
  });

  it('refuses a folder upload whose path count does not match the files', async () => {
    const { controller, sources } = makeController();

    await expect(
      controller.upload(ctx, [incomingUpload('a.json')], { paths: ['a/a.json', 'a/b.json'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sources.registerUpload).not.toHaveBeenCalled();
  });

  it('refuses an empty upload before touching anything', async () => {
    const { controller, sources } = makeController();

    await expect(controller.upload(ctx, [])).rejects.toBeInstanceOf(BadRequestException);
    expect(sources.registerUpload).not.toHaveBeenCalled();
  });
});

describe('ImportUploadsController.onModuleInit', () => {
  it('never throws when the uploads directory cannot be created — boot must survive', async () => {
    // Point the uploads dir under a directory this process cannot write.
    // Multer's string-dest form mkdirs at class definition and would crash
    // the whole API here; the function-destination form defers to request
    // time, and init only warns. (A real read-only dir, not /proc: recursive
    // mkdir under procfs spins forever on some kernels.)
    const readonly = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-readonly-'));

    fs.chmodSync(readonly, 0o555);
    (config.import as { uploadsDir: string }).uploadsDir = path.join(readonly, 'uploads');

    const { controller } = makeController();

    await expect(controller.onModuleInit()).resolves.toBeUndefined();

    fs.chmodSync(readonly, 0o755);
  });
});

describe('ImportUploadsController.list / remove', () => {
  it('lists staged uploads for the caller', async () => {
    const { controller, sources } = makeController();

    await controller.list(ctx);

    expect(sources.listStagedUploads).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('404s a remove the service refused', async () => {
    const { controller, sources } = makeController();

    sources.releaseUpload.mockResolvedValueOnce(false);

    await expect(controller.remove(ctx, 'drop-x')).rejects.toBeInstanceOf(NotFoundException);
  });
});
