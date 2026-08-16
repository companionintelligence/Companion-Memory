import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StageRunContext } from '../../types';
import { MediaStage } from '../MediaStage';

/**
 * What matters here is the ledger, not the upload: this stage exists because
 * the bytes were being deleted with the scratch tree while the rows that
 * describe them claimed success, so the assertions are about a row ending up
 * pointing at a stored file — or, when it cannot, saying so once and not
 * spinning on it.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function makeStage(rows: Array<Record<string, unknown>>, upload?: jest.Mock) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  let served = false;

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('UPDATE')) {
        updates.push({ sql, params });

        return [];
      }

      if (sql.includes('count(*)')) {
        // The uploaded/carried-over probe asks without the media predicate.
        if (sql.includes("FileMediaError' IS NOT NULL")) {
          return [{ count: 0 }];
        }

        return [{ count: rows.length }];
      }

      // The batch read: serve the rows once, then drain.
      if (served) {
        return [];
      }

      served = true;

      return rows;
    }),
  };

  const files = {
    uploadWithDedupInfo: upload ?? jest.fn(async () => ({ file: { id: 'file-1' }, deduped: false })),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  return {
    stage: new MediaStage(dataSource as never, files as never, logger as never),
    updates,
    files,
  };
}

function contextFor(scratchDir: string): StageRunContext {
  return {
    runId: RUN_ID,
    userId: USER_ID,
    stageId: '22222222-2222-4222-8222-222222222222',
    scratchDir,
    progress: jest.fn(async () => undefined),
    log: jest.fn(),
  } as unknown as StageRunContext;
}

describe('MediaStage', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-mediastage-'));
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('stores a media file and points the staged row at it', async () => {
    const photo = path.join(scratchDir, 'photo.jpg');
    fs.writeFileSync(photo, 'jpegbytes');

    const { stage, updates, files } = makeStage([
      { id: 'row-1', filename: 'photo.jpg', mediaType: 'image/jpeg', sizeBytes: 9, localPath: photo },
    ]);

    const outcome = await stage.run(contextFor(scratchDir));

    expect(files.uploadWithDedupInfo).toHaveBeenCalledWith(
      { userId: USER_ID },
      expect.objectContaining({ path: photo, contentType: 'image/jpeg' }),
    );
    // The whole point: the row now carries the id the push reads as FileId.
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('FileId');
    expect(updates[0].params).toEqual(['row-1', 'file-1']);
    expect(outcome.detail).toMatchObject({ uploaded: 1, failed: 0 });
  });

  it('counts an already-stored file as deduped rather than uploaded', async () => {
    const photo = path.join(scratchDir, 'again.jpg');
    fs.writeFileSync(photo, 'same');

    const { stage } = makeStage(
      [{ id: 'row-2', filename: 'again.jpg', mediaType: 'image/jpeg', sizeBytes: 4, localPath: photo }],
      jest.fn(async () => ({ file: { id: 'file-existing' }, deduped: true })),
    );

    const outcome = await stage.run(contextFor(scratchDir));

    // Dedup is the store's answer, and it is what makes re-importing the same
    // archive cost nothing rather than duplicating every photo.
    expect(outcome.detail).toMatchObject({ uploaded: 0, deduped: 1, failed: 0 });
  });

  it('refuses a path outside the run scratch directory', async () => {
    // The path comes from a parser reading a user-supplied archive; without this
    // the stage would be a primitive for reading any file the API can see.
    const outside = path.join(os.tmpdir(), 'ci-mediastage-outsider.jpg');
    fs.writeFileSync(outside, 'nope');

    const { stage, updates, files } = makeStage([
      { id: 'row-3', filename: 'outsider.jpg', mediaType: 'image/jpeg', sizeBytes: 4, localPath: outside },
    ]);

    const outcome = await stage.run(contextFor(scratchDir));

    expect(files.uploadWithDedupInfo).not.toHaveBeenCalled();
    expect(updates[0].sql).toContain('FileMediaError');
    expect(outcome.partial).toBe(true);

    fs.rmSync(outside, { force: true });
  });

  it('records an unreadable file once instead of retrying it forever', async () => {
    const missing = path.join(scratchDir, 'gone.jpg');

    const { stage, updates } = makeStage([
      { id: 'row-4', filename: 'gone.jpg', mediaType: 'image/jpeg', sizeBytes: 1, localPath: missing },
    ]);

    const outcome = await stage.run(contextFor(scratchDir));

    // Stamped with the error key, which the selection query excludes — so the
    // next attempt skips it rather than spinning on the same dead path.
    expect(updates[0].sql).toContain('FileMediaError');
    expect(outcome.detail).toMatchObject({ failed: 1 });
    expect(outcome.partial).toBe(true);
  });

  it('finishes cleanly on an archive with no media at all', async () => {
    const { stage, files } = makeStage([]);

    const outcome = await stage.run(contextFor(scratchDir));

    expect(files.uploadWithDedupInfo).not.toHaveBeenCalled();
    expect(outcome.partial).toBeUndefined();
    expect(outcome.detail).toMatchObject({ uploaded: 0, failed: 0 });
  });
});
