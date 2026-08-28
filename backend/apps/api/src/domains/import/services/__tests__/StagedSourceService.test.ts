import { mkdtemp, mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import config from '@ci/configuration';

import { StagedSourceService } from '../StagedSourceService';

/**
 * The registry's filesystem half, over a mocked repository and a REAL tmp
 * uploads directory — the SQL half lives in stagedSourceRegistry/Spine
 * against real Postgres. What is pinned here:
 *
 *  - the purge takes the row out of the staged pool with a COMPARE-AND-SWAP
 *    before it deletes anything, so a run that claims the upload in the gap
 *    wins outright — the old ordering deleted a live run's archive and then
 *    overwrote its `claimed` row with an `expired` tombstone;
 *  - a failed unlink puts the row back, so bytes are never orphaned;
 *  - the orphan sweep takes only what no row accounts for, and only past the
 *    TTL;
 *  - the deletion site refuses paths outside the uploads root, whatever a
 *    row says.
 */

const stubLogger = () =>
  ({ setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() }) as never;

let uploadsDir: string;
let previousUploadsDir: string;

beforeEach(async () => {
  uploadsDir = await mkdtemp(path.join(os.tmpdir(), 'ci-stagedsvc-'));
  previousUploadsDir = config.import.uploadsDir;
  (config.import as { uploadsDir: string }).uploadsDir = uploadsDir;
});

afterEach(() => {
  (config.import as { uploadsDir: string }).uploadsDir = previousUploadsDir;
});

async function seedDropDir(dropId: string, filename = 'export.zip'): Promise<string> {
  const dir = path.join(uploadsDir, dropId);

  await mkdir(dir, { recursive: true });

  const filePath = path.join(dir, filename);

  await writeFile(filePath, 'bytes');

  return filePath;
}

/** Age a path past the TTL so the sweeps consider it. */
async function ageOut(target: string): Promise<void> {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);

  await utimes(target, old, old);
}

function build(rows: Array<Record<string, unknown>> = []) {
  const repo = {
    find: jest.fn(async () => rows),
    findOne: jest.fn(async () => rows[0] ?? null),
    update: jest.fn<Promise<{ affected: number }>, [Record<string, unknown>, unknown]>(async () => ({
      affected: 1,
    })),
    delete: jest.fn(async () => ({ affected: 1 })),
    exist: jest.fn<Promise<boolean>, [{ where: { dropId: string } }]>(async () => false),
    // `dropDirIsLive` falls through to a raw EXISTS over the run join when no
    // row is in a live status; unfinished runs are opt-in per test.
    query: jest.fn(async () => [{ live: false }]),
  };

  return { service: new StagedSourceService(repo as never, stubLogger()), repo };
}

describe('purgeExpired', () => {
  it('claims the row out of the staged pool, then deletes the bytes', async () => {
    const filePath = await seedDropDir('drop-1');
    const { service, repo } = build([
      { id: 'row-1', dropId: 'drop-1', sourcePath: filePath, status: 'staged' },
    ]);

    expect(await service.purgeExpired()).toBe(1);
    await expect(stat(path.dirname(filePath))).rejects.toMatchObject({ code: 'ENOENT' });
    // Constrained to `status: 'staged'` — that predicate IS the race guard.
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'row-1', status: 'staged' }), {
      status: 'expired',
    });
  });

  /**
   * The reproduced race. `purgeExpired` reads the stale rows, then deletes each
   * file, then stamps `expired`. A run that claimed the upload in the gap used
   * to have its archive deleted out from under it AND its live `claimed` row
   * overwritten by the unconstrained stamp — so the unpack failed with "no
   * claimed source" over bytes that no longer existed, and nothing was left to
   * say where they had gone.
   */
  it('leaves an upload a run claimed between the read and the delete', async () => {
    const filePath = await seedDropDir('drop-raced');
    const { service, repo } = build([
      { id: 'row-raced', dropId: 'drop-raced', sourcePath: filePath, status: 'staged' },
    ]);

    // The CAS finds the row no longer `staged` — a run got there first.
    repo.update.mockResolvedValue({ affected: 0 } as never);

    expect(await service.purgeExpired()).toBe(0);

    // The live run's archive is untouched...
    expect((await stat(filePath)).size).toBe(5);
    // ...and its claim was never tombstoned: the CAS is the ONLY write aimed at
    // this row. (The sweep's first statement is the run-less-claim adoption,
    // which names no id — see `restageOrphanedClaims`.)
    expect(repo.update.mock.calls.filter(([criteria]) => 'id' in criteria)).toHaveLength(1);
  });

  it('puts the row back when the delete fails, so the next sweep retries it', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ci-outside-'));
    const { service, repo } = build([
      {
        id: 'row-undeletable',
        dropId: 'drop-undeletable',
        sourcePath: path.join(outside, 'x.zip'),
        status: 'staged',
      },
    ]);

    expect(await service.purgeExpired()).toBe(0);

    // An `expired` row whose file survived is invisible to this sweep forever.
    expect(repo.update).toHaveBeenLastCalledWith(
      { id: 'row-undeletable', status: 'expired' },
      {
        status: 'staged',
      },
    );
  });

  it('refuses to delete a row pointing outside the uploads root, and leaves it staged', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ci-outside-'));
    const victim = path.join(outside, 'passwd');

    await writeFile(victim, 'root:x:0:0');

    const { service, repo } = build([
      { id: 'row-evil', dropId: 'drop-evil', sourcePath: victim, status: 'staged' },
    ]);

    // Counted as not-reclaimed; the row is put back for a human to notice.
    expect(await service.purgeExpired()).toBe(0);
    expect((await stat(victim)).size).toBeGreaterThan(0);
    expect(repo.update).toHaveBeenLastCalledWith(
      { id: 'row-evil', status: 'expired' },
      {
        status: 'staged',
      },
    );
  });
});

describe('sweepUploadOrphans', () => {
  it('takes aged drop directories no row accounts for, and leaves live ones', async () => {
    await seedDropDir('orphan-drop');
    await seedDropDir('live-drop');
    await ageOut(path.join(uploadsDir, 'orphan-drop'));
    await ageOut(path.join(uploadsDir, 'live-drop'));

    const { service, repo } = build();

    repo.exist.mockImplementation(
      async (query: { where: { dropId: string } }) => query.where.dropId === 'live-drop',
    );

    expect(await service.sweepUploadOrphans()).toBe(1);

    const remaining = await readdir(uploadsDir);

    expect(remaining).toContain('live-drop');
    expect(remaining).not.toContain('orphan-drop');
  });

  it('takes aged incoming files but never fresh ones, and keeps incoming/ itself', async () => {
    const incoming = path.join(uploadsDir, 'incoming');

    await mkdir(incoming);
    await writeFile(path.join(incoming, 'stale'), 'x');
    await writeFile(path.join(incoming, 'fresh'), 'x');
    await ageOut(path.join(incoming, 'stale'));
    await ageOut(incoming);

    const { service } = build();

    expect(await service.sweepUploadOrphans()).toBe(1);
    expect(await readdir(incoming)).toEqual(['fresh']);
  });

  /**
   * The status test alone is not enough. A row can leave the live statuses
   * while its run is still going — a retried stage, or a status stamped by a
   * racing sweep — and deleting an in-flight run's archive is unrecoverable
   * where keeping it an extra hour costs disk. The tie goes to the run.
   */
  it('leaves a drop directory whose run has not finished, whatever its row status says', async () => {
    await seedDropDir('running-drop');
    await ageOut(path.join(uploadsDir, 'running-drop'));

    const { service, repo } = build();

    // No row in a live STATUS...
    repo.exist.mockResolvedValue(false as never);
    // ...but the run behind it is unfinished.
    repo.query.mockResolvedValue([{ live: true }] as never);

    expect(await service.sweepUploadOrphans()).toBe(0);
    expect(await readdir(uploadsDir)).toContain('running-drop');
  });

  it('touches nothing younger than the TTL', async () => {
    await seedDropDir('fresh-drop');

    const { service } = build();

    expect(await service.sweepUploadOrphans()).toBe(0);
    expect(await readdir(uploadsDir)).toContain('fresh-drop');
  });
});

describe('reclaimMovedUploadDir', () => {
  it('removes the empty wrapper, refuses non-empty and out-of-root ones, ignores inbox', async () => {
    const emptied = path.join(uploadsDir, 'drop-moved');
    const occupied = await seedDropDir('drop-busy');
    const { service } = build();

    await mkdir(emptied, { recursive: true });

    await service.reclaimMovedUploadDir({ origin: 'upload', sourcePath: path.join(emptied, 'gone.zip') });
    await expect(stat(emptied)).rejects.toMatchObject({ code: 'ENOENT' });

    // rmdir is non-recursive by design: a wrapper still holding bytes stays.
    await service.reclaimMovedUploadDir({ origin: 'upload', sourcePath: occupied });
    expect((await stat(path.dirname(occupied))).isDirectory()).toBe(true);

    // Outside the uploads root: silently refused, nothing touched.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ci-outside-'));

    await service.reclaimMovedUploadDir({ origin: 'upload', sourcePath: path.join(outside, 'x.zip') });
    expect((await stat(outside)).isDirectory()).toBe(true);

    // Inbox units have no wrapper.
    await service.reclaimMovedUploadDir({ origin: 'inbox', sourcePath: path.join(uploadsDir, 'nope', 'x') });
  });
});

describe('releaseUpload', () => {
  it('removes a staged upload, bytes and row', async () => {
    const filePath = await seedDropDir('drop-r');
    const { service, repo } = build([
      { id: 'row-r', dropId: 'drop-r', sourcePath: filePath, status: 'staged' },
    ]);

    expect(await service.releaseUpload({ userId: 'u' }, 'drop-r')).toBe(true);
    await expect(stat(path.dirname(filePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(repo.delete).toHaveBeenCalledWith({ id: 'row-r' });
  });

  it('refuses a claimed upload — its run owns the bytes now', async () => {
    const filePath = await seedDropDir('drop-c');
    const { service, repo } = build([
      { id: 'row-c', dropId: 'drop-c', sourcePath: filePath, status: 'claimed' },
    ]);

    expect(await service.releaseUpload({ userId: 'u' }, 'drop-c')).toBe(false);
    expect((await stat(filePath)).size).toBe(5);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('dismisses an expired tombstone without touching the filesystem', async () => {
    const { service, repo } = build([
      {
        id: 'row-e',
        dropId: 'drop-e',
        sourcePath: path.join(uploadsDir, 'gone', 'x.zip'),
        status: 'expired',
      },
    ]);

    expect(await service.releaseUpload({ userId: 'u' }, 'drop-e')).toBe(true);
    expect(repo.delete).toHaveBeenCalledWith({ id: 'row-e' });
  });
});
