import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import config from '@ci/configuration';

import { PathOutsideImportRootsError } from '../importRoots';
import {
  acquireLocalUnit,
  ClaimReleasedDuringCopyError,
  inboxUnitInScratch,
  returnInboxUnit,
} from '../localAcquire';

/**
 * The transactional move that consumes an inbox unit — the only code that
 * mutates the inbox. Every case here is a crash window or a safety property:
 * the recovery ordering decides whether a retry finishes the move, restarts
 * it, or leaves a newcomer alone, and getting one branch wrong either loses
 * bytes or moves bytes the run does not own.
 */

async function withInbox<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = config.import.inboxDir;

  (config.import as { inboxDir: string }).inboxDir = dir;

  try {
    return await run();
  } finally {
    (config.import as { inboxDir: string }).inboxDir = previous;
  }
}

async function fixture(): Promise<{ inbox: string; scratch: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ci-acquire-'));
  const inbox = path.join(parent, 'inbox');
  const scratch = path.join(parent, 'scratch');

  await mkdir(inbox);
  await mkdir(scratch);

  return { inbox, scratch };
}

const log = () => undefined;

describe('acquireLocalUnit', () => {
  it('moves a file into scratch by rename', async () => {
    const { inbox, scratch } = await fixture();
    const source = path.join(inbox, 'export.zip');

    await writeFile(source, 'bytes');

    await withInbox(inbox, async () => {
      const result = await acquireLocalUnit({ sourcePath: source, scratchDir: scratch, sizeBytes: 5, log });

      expect(result.method).toBe('rename');
      expect(await readFile(result.destPath, 'utf8')).toBe('bytes');
      await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('moves a directory tree the same way', async () => {
    const { inbox, scratch } = await fixture();
    const source = path.join(inbox, 'takeout');

    await mkdir(path.join(source, 'Mail'), { recursive: true });
    await writeFile(path.join(source, 'Mail', 'inbox.mbox'), 'mail');

    await withInbox(inbox, async () => {
      const result = await acquireLocalUnit({ sourcePath: source, scratchDir: scratch, sizeBytes: 4, log });

      expect(result.method).toBe('rename');
      expect(await readFile(path.join(result.destPath, 'Mail', 'inbox.mbox'), 'utf8')).toBe('mail');
      await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('recovers when a previous attempt already finalized', async () => {
    // Crash window: after the finalize rename, before the DB row moved. The
    // retry must NOT re-move — a same-named newcomer in the inbox belongs to a
    // later batch, not to this run.
    const { inbox, scratch } = await fixture();
    const newcomer = path.join(inbox, 'export.zip');

    await writeFile(path.join(scratch, 'export.zip'), 'moved-bytes');
    await writeFile(newcomer, 'newcomer-bytes');

    await withInbox(inbox, async () => {
      const result = await acquireLocalUnit({
        sourcePath: newcomer,
        scratchDir: scratch,
        sizeBytes: 5,
        log,
      });

      expect(result.method).toBe('recovered');
      expect(await readFile(result.destPath, 'utf8')).toBe('moved-bytes');
      // The newcomer is untouched.
      expect(await readFile(newcomer, 'utf8')).toBe('newcomer-bytes');
    });
  });

  it('finishes an interrupted move when the source is gone', async () => {
    // Crash window: after rename(source, tmp), before rename(tmp, dest).
    const { inbox, scratch } = await fixture();
    const source = path.join(inbox, 'export.zip');

    await writeFile(path.join(scratch, '.acquiring-export.zip'), 'bytes');

    await withInbox(inbox, async () => {
      const result = await acquireLocalUnit({ sourcePath: source, scratchDir: scratch, sizeBytes: 5, log });

      expect(result.method).toBe('recovered');
      expect(await readFile(result.destPath, 'utf8')).toBe('bytes');
      expect(await readdir(scratch)).toEqual(['export.zip']);
    });
  });

  it('scraps a partial copy when the source is still intact', async () => {
    // Crash window: a copy fallback died mid-write. The source is whole, so
    // the partial tmp is garbage and the move starts over.
    const { inbox, scratch } = await fixture();
    const source = path.join(inbox, 'export.zip');

    await writeFile(source, 'bytes');
    await writeFile(path.join(scratch, '.acquiring-export.zip'), 'partial');

    await withInbox(inbox, async () => {
      const result = await acquireLocalUnit({ sourcePath: source, scratchDir: scratch, sizeBytes: 5, log });

      expect(result.method).toBe('rename');
      expect(await readFile(result.destPath, 'utf8')).toBe('bytes');
    });
  });

  it('falls back to copy-then-delete across filesystems', async () => {
    const { inbox, scratch } = await fixture();
    const source = path.join(inbox, 'takeout');

    await mkdir(source);
    await writeFile(path.join(source, 'data.json'), 'data');

    // Simulate EXDEV on the source→tmp rename only; the tmp→dest finalize is
    // same-filesystem and must still work.
    let renames = 0;
    const exdevOnce: typeof rename = async (from, to) => {
      renames += 1;

      if (renames === 1) {
        const err = new Error('cross-device link') as Error & { code: string };

        err.code = 'EXDEV';
        throw err;
      }

      return rename(from, to);
    };

    await withInbox(inbox, async () => {
      const result = await acquireLocalUnit({
        sourcePath: source,
        scratchDir: scratch,
        sizeBytes: 4,
        log,
        renameImpl: exdevOnce,
      });

      expect(result.method).toBe('copy');
      expect(await readFile(path.join(result.destPath, 'data.json'), 'utf8')).toBe('data');
      // Deleted only after the copy completed.
      await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('leaves the source in place when the claim was released while it was copied', async () => {
    const { inbox, scratch } = await fixture();
    const source = path.join(inbox, 'export.zip');

    await writeFile(source, 'zip bytes');

    const exdev: typeof rename = async (from, to) => {
      if (from === source) {
        const err = new Error('cross-device link') as Error & { code: string };

        err.code = 'EXDEV';
        throw err;
      }

      return rename(from, to);
    };

    await withInbox(inbox, async () => {
      await expect(
        acquireLocalUnit({
          sourcePath: source,
          scratchDir: scratch,
          sizeBytes: 9,
          log,
          renameImpl: exdev,
          // The run was cancelled during the copy.
          stillClaimed: async () => false,
        }),
      ).rejects.toBeInstanceOf(ClaimReleasedDuringCopyError);

      expect(await readFile(source, 'utf8')).toBe('zip bytes');
      expect(await readdir(scratch)).toEqual([]);
    });
  });

  it('refuses a source outside the inbox at the mutation site', async () => {
    // Defense in depth: the claim validated the path once, but a row edited to
    // point elsewhere must be refused HERE, where the moving and deleting
    // happens — and refused before anything is touched.
    const { inbox, scratch } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ci-outside-'));
    const victim = path.join(outside, 'passwd');

    await writeFile(victim, 'root:x:0:0');

    await withInbox(inbox, async () => {
      await expect(
        acquireLocalUnit({ sourcePath: victim, scratchDir: scratch, sizeBytes: 10, log }),
      ).rejects.toBeInstanceOf(PathOutsideImportRootsError);

      // Untouched.
      expect(await readFile(victim, 'utf8')).toBe('root:x:0:0');
    });

    await rm(outside, { recursive: true, force: true });
  });
});

/**
 * The way back, for a discarded run: the unit was the user's only copy, so it
 * returns to the inbox rather than going with the scratch tree. It never
 * lands on top of anything already there.
 */
describe('returnInboxUnit', () => {
  it('puts a unit back under its own name', async () => {
    const { inbox, scratch } = await fixture();
    const source = path.join(inbox, 'export.zip');
    const unit = path.join(scratch, 'export.zip');

    await writeFile(unit, 'bytes');

    const returned = await returnInboxUnit({ unitPath: unit, sourcePath: source, inboxDir: inbox, log });

    expect(returned).toBe(source);
    expect(await readFile(source, 'utf8')).toBe('bytes');
    await expect(stat(unit)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('takes a free name rather than overwriting a newer file, keeping a compound extension whole', async () => {
    const { inbox, scratch } = await fixture();

    await writeFile(path.join(inbox, 'mail.tar.gz'), 'newer');
    await writeFile(path.join(inbox, 'mail (2).tar.gz'), 'newer still');
    await writeFile(path.join(scratch, 'mail.tar.gz'), 'original');

    const returned = await returnInboxUnit({
      unitPath: path.join(scratch, 'mail.tar.gz'),
      sourcePath: path.join(inbox, 'mail.tar.gz'),
      inboxDir: inbox,
      log,
    });

    expect(path.basename(returned)).toBe('mail (3).tar.gz');
    expect(await readFile(returned, 'utf8')).toBe('original');
    expect(await readFile(path.join(inbox, 'mail.tar.gz'), 'utf8')).toBe('newer');
  });

  it('recreates the folder a unit came from, with the inbox folder mode', async () => {
    const { inbox, scratch } = await fixture();
    const unit = path.join(scratch, 'export.zip');

    await writeFile(unit, 'bytes');

    const returned = await returnInboxUnit({
      unitPath: unit,
      sourcePath: path.join(inbox, 'google', 'export.zip'),
      inboxDir: inbox,
      log,
    });

    expect(returned).toBe(path.join(inbox, 'google', 'export.zip'));
    expect((await stat(path.join(inbox, 'google'))).mode & 0o7777).toBe(0o1777);
  });

  it('refuses a directory unit, which the unpack changed in place', async () => {
    const { inbox, scratch } = await fixture();

    await mkdir(path.join(scratch, 'Takeout', 'Mail'), { recursive: true });

    await expect(
      returnInboxUnit({
        unitPath: path.join(scratch, 'Takeout'),
        sourcePath: path.join(inbox, 'Takeout'),
        inboxDir: inbox,
        log,
      }),
    ).rejects.toThrow(/Only a file unit goes back/);
    expect(await readdir(inbox)).toEqual([]);
  });

  it('brings back a source path that points outside the inbox at the inbox top level', async () => {
    const { inbox, scratch } = await fixture();

    await writeFile(path.join(scratch, 'export.zip'), 'bytes');

    const returned = await returnInboxUnit({
      unitPath: path.join(scratch, 'export.zip'),
      sourcePath: '/etc/elsewhere/export.zip',
      inboxDir: inbox,
      log,
    });

    expect(returned).toBe(path.join(inbox, 'export.zip'));
  });

  it('refuses a parent folder that is a symlink out of the inbox', async () => {
    const { inbox, scratch } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ci-acquire-outside-'));

    await symlink(outside, path.join(inbox, 'linked'));
    await writeFile(path.join(scratch, 'export.zip'), 'bytes');

    await expect(
      returnInboxUnit({
        unitPath: path.join(scratch, 'export.zip'),
        sourcePath: path.join(inbox, 'linked', 'export.zip'),
        inboxDir: inbox,
        log,
      }),
    ).rejects.toBeInstanceOf(PathOutsideImportRootsError);
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(path.join(scratch, 'export.zip'), 'utf8')).toBe('bytes');

    await rm(outside, { recursive: true, force: true });
  });

  it('makes no folder through such a symlink on the way to a deeper path', async () => {
    const { inbox, scratch } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ci-acquire-outside-'));

    await symlink(outside, path.join(inbox, 'linked'));
    await writeFile(path.join(scratch, 'export.zip'), 'bytes');

    await expect(
      returnInboxUnit({
        unitPath: path.join(scratch, 'export.zip'),
        sourcePath: path.join(inbox, 'linked', 'deeper', 'export.zip'),
        inboxDir: inbox,
        log,
      }),
    ).rejects.toBeInstanceOf(PathOutsideImportRootsError);
    expect(await readdir(outside)).toEqual([]);

    await rm(outside, { recursive: true, force: true });
  });

  it('never replaces a file that takes the name while it runs', async () => {
    const { inbox, scratch } = await fixture();
    const unit = path.join(scratch, 'export.zip');

    await writeFile(unit, 'the only copy');

    // The name is free when it is checked and taken by the time it is linked.
    let raced = false;
    const returned = await returnInboxUnit({
      unitPath: unit,
      sourcePath: path.join(inbox, 'export.zip'),
      inboxDir: inbox,
      log,
      linkImpl: async (from, to) => {
        if (!raced) {
          raced = true;
          await writeFile(path.join(inbox, 'export.zip'), 'arrived meanwhile');
        }

        const { link } = await import('node:fs/promises');

        return link(from, to);
      },
    });

    expect(path.basename(returned)).toBe('export (2).zip');
    expect(await readFile(path.join(inbox, 'export.zip'), 'utf8')).toBe('arrived meanwhile');
    expect(await readFile(returned, 'utf8')).toBe('the only copy');
  });

  it('does not place a second copy when an earlier return linked the unit and stopped', async () => {
    const { inbox, scratch } = await fixture();
    const unit = path.join(scratch, 'export.zip');
    const source = path.join(inbox, 'export.zip');

    await writeFile(unit, 'the only copy');
    // What a crash between the link and the scratch unlink leaves: the same
    // file under both names.
    await link(unit, source);

    const returned = await returnInboxUnit({ unitPath: unit, sourcePath: source, inboxDir: inbox, log });

    expect(returned).toBe(source);
    expect(await readdir(inbox)).toEqual(['export.zip']);
    await expect(stat(unit)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('comes back at the top level when a folder on its old path is a file now', async () => {
    const { inbox, scratch } = await fixture();
    const unit = path.join(scratch, 'export.zip');

    await writeFile(path.join(inbox, 'google'), 'a file where the folder was');
    await writeFile(unit, 'bytes');

    const returned = await returnInboxUnit({
      unitPath: unit,
      sourcePath: path.join(inbox, 'google', 'export.zip'),
      inboxDir: inbox,
      log,
    });

    expect(returned).toBe(path.join(inbox, 'export.zip'));
    expect(await readFile(returned, 'utf8')).toBe('bytes');
    expect(await readFile(path.join(inbox, 'google'), 'utf8')).toBe('a file where the folder was');
  });

  it('comes back at the top level when a dangling symlink sits where its folder was', async () => {
    const { inbox, scratch } = await fixture();
    const unit = path.join(scratch, 'export.zip');

    await symlink(path.join(inbox, 'gone'), path.join(inbox, 'google'));
    await writeFile(unit, 'bytes');

    const returned = await returnInboxUnit({
      unitPath: unit,
      sourcePath: path.join(inbox, 'google', 'export.zip'),
      inboxDir: inbox,
      log,
    });

    expect(returned).toBe(path.join(inbox, 'export.zip'));
    expect(await readFile(returned, 'utf8')).toBe('bytes');
  });

  it('does not place a second copy across filesystems when an earlier return stopped after the link', async () => {
    // Root ignores the folder mode, so the failed scratch unlink cannot be staged.
    if (process.getuid?.() === 0) {
      return;
    }

    const { inbox, scratch } = await fixture();
    const unit = path.join(scratch, 'export.zip');
    const crossDevice = async (): Promise<void> => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    };

    await writeFile(unit, 'the only copy');

    // The copy is linked into place, then the scratch unlink fails.
    await chmod(scratch, 0o555);

    try {
      await expect(
        returnInboxUnit({
          unitPath: unit,
          sourcePath: path.join(inbox, 'export.zip'),
          inboxDir: inbox,
          log,
          linkImpl: crossDevice,
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(scratch, 0o755);
    }

    const returned = await returnInboxUnit({
      unitPath: unit,
      sourcePath: path.join(inbox, 'export.zip'),
      inboxDir: inbox,
      log,
      linkImpl: crossDevice,
    });

    expect(returned).toBe(path.join(inbox, 'export.zip'));
    expect(await readdir(inbox)).toEqual(['export.zip']);
    expect(await readFile(returned, 'utf8')).toBe('the only copy');
    await expect(stat(unit)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies back across filesystems, deleting the scratch copy only after', async () => {
    const { inbox, scratch } = await fixture();
    const unit = path.join(scratch, 'export.zip');

    await writeFile(unit, 'bytes');

    const returned = await returnInboxUnit({
      unitPath: unit,
      sourcePath: path.join(inbox, 'export.zip'),
      inboxDir: inbox,
      log,
      linkImpl: async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      },
    });

    expect(returned).toBe(path.join(inbox, 'export.zip'));
    expect(await readFile(returned, 'utf8')).toBe('bytes');
    await expect(stat(unit)).rejects.toMatchObject({ code: 'ENOENT' });
    // The temp copy it linked into place is gone too.
    expect(await readdir(inbox)).toEqual(['export.zip']);
  });
});

describe('inboxUnitInScratch', () => {
  it('finds the unit where the acquire left it', async () => {
    const { inbox, scratch } = await fixture();

    await writeFile(path.join(scratch, 'export.zip'), 'bytes');

    expect(await inboxUnitInScratch(path.join(inbox, 'export.zip'), scratch)).toBe(
      path.join(scratch, 'export.zip'),
    );
  });

  it('finds it under the temp name when a crash split the two renames', async () => {
    const { inbox, scratch } = await fixture();

    await writeFile(path.join(scratch, '.acquiring-export.zip'), 'bytes');

    expect(await inboxUnitInScratch(path.join(inbox, 'export.zip'), scratch)).toBe(
      path.join(scratch, '.acquiring-export.zip'),
    );
  });

  it('does not count a dead copy fallback while the original is still in the inbox', async () => {
    const { inbox, scratch } = await fixture();

    await writeFile(path.join(inbox, 'export.zip'), 'bytes');
    await writeFile(path.join(scratch, '.acquiring-export.zip'), 'by');

    expect(await inboxUnitInScratch(path.join(inbox, 'export.zip'), scratch)).toBeNull();
  });

  it('finds nothing once an archive was unpacked and deleted', async () => {
    const { inbox, scratch } = await fixture();

    await writeFile(path.join(scratch, 'all.mbox'), 'mbox');

    expect(await inboxUnitInScratch(path.join(inbox, 'export.zip'), scratch)).toBeNull();
  });
});
