import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DataSource } from 'typeorm';

import config from '@ci/configuration';

import { UnpackStage } from '../stages/UnpackStage';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAGED SOURCES END TO END, AGAINST REAL POSTGRES AND A REAL FILESYSTEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The claims are SQL racing indexes, and their correctness story — a lost
 * claim takes its run row with it, a released inbox claim frees the path, a
 * released UPLOAD is re-staged rather than stranded, consumption is
 * terminal-state-driven — is transaction behavior only a real database
 * demonstrates. The filesystem half (the move) runs against real tmp
 * directories through the real UnpackStage, because the consume contract is
 * "the source LEAVES its staging area", and only a filesystem can say
 * whether it did.
 *
 * Suites here skip without the DB env — see support/stagingHarness.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/stagedSourceSpine.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`staged source runs (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let dataSource: DataSource;
  let userId: string;
  let inbox: string;
  let uploads: string;
  let scratchParent: string;
  let previousInbox: string;
  let previousUploads: string;

  const createdRuns: string[] = [];

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());
    ({ dataSource, userId } = harness);

    const parent = await mkdtemp(path.join(os.tmpdir(), 'ci-stagedspine-'));

    inbox = path.join(parent, 'inbox');
    uploads = path.join(parent, 'uploads');
    scratchParent = path.join(parent, 'scratch');
    await mkdir(inbox);
    await mkdir(uploads);
    await mkdir(scratchParent);

    previousInbox = config.import.inboxDir;
    previousUploads = config.import.uploadsDir;
    (config.import as { inboxDir: string }).inboxDir = inbox;
    (config.import as { uploadsDir: string }).uploadsDir = uploads;
  });

  afterAll(async () => {
    (config.import as { inboxDir: string }).inboxDir = previousInbox;
    (config.import as { uploadsDir: string }).uploadsDir = previousUploads;

    // staged_sources rows survive their run's delete with run_id = NULL (the
    // no-orphaning rule), so the spec sweeps its own — scoped by the
    // harness's unique user — before the runs go.
    await dataSource.query(`DELETE FROM ci_import.staged_sources WHERE user_id = $1::uuid`, [userId]);

    for (const runId of createdRuns) {
      await dataSource.query(`DELETE FROM ci_import.import_runs WHERE id = $1::uuid`, [runId]);
    }

    await teardown();
  });

  function makeUnpackStage() {
    return new UnpackStage(dataSource, harness.stagedSources, {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as never);
  }

  async function seedInboxUnit(name: string, kind: 'file' | 'directory'): Promise<string> {
    const target = path.join(inbox, name);

    if (kind === 'file') {
      await writeFile(target, 'bytes');
    } else {
      await mkdir(path.join(target, 'Mail'), { recursive: true });
      await writeFile(path.join(target, 'Mail', 'inbox.mbox'), 'mail');
    }

    return target;
  }

  async function startInbox(sourcePath: string, kind: 'file' | 'directory') {
    const result = await harness.service.startRun(
      { userId },
      { localSource: { path: sourcePath, kind, sizeBytes: 5 }, source: 'api' },
    );

    createdRuns.push(result.run.id);

    return result;
  }

  /** A REAL staged upload: bytes on disk under the uploads dir, plus its row. */
  async function seedUpload(filename = 'export.zip') {
    const dropId = `spine-${Math.random().toString(36).slice(2)}`;
    const dropDir = path.join(uploads, dropId);
    const sourcePath = path.join(dropDir, filename);

    await mkdir(dropDir, { recursive: true });
    await writeFile(sourcePath, 'bytes');

    await harness.stagedSources.registerUpload(
      { userId },
      { dropId, sourcePath, originalFilename: filename, sizeBytes: 5 },
    );

    return { dropId, sourcePath };
  }

  async function startUpload(dropId: string) {
    const result = await harness.service.startRun({ userId }, { dropId, source: 'api' });

    createdRuns.push(result.run.id);

    return result;
  }

  async function rowByRunId(runId: string) {
    const rows = await dataSource.query<
      Array<{ status: string; source_path: string; run_id: string | null }>
    >(`SELECT status, source_path, run_id FROM ci_import.staged_sources WHERE run_id = $1::uuid`, [runId]);

    return rows[0] ?? null;
  }

  async function rowByDropId(dropId: string) {
    const rows = await dataSource.query<
      Array<{ status: string; run_id: string | null; expires_at: Date | null }>
    >(
      `SELECT status, run_id, expires_at FROM ci_import.staged_sources
        WHERE user_id = $1::uuid AND drop_id = $2`,
      [userId, dropId],
    );

    return rows[0] ?? null;
  }

  describe('the inbox claim', () => {
    it('binds one live run to one path, and a lost claim takes its run with it', async () => {
      const source = await seedInboxUnit('claim-race.zip', 'file');
      const { run } = await startInbox(source, 'file');

      expect((await rowByRunId(run.id))?.status).toBe('claimed');

      const runsBefore = await dataSource.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM ci_import.import_runs WHERE user_id = $1::uuid`,
        [userId],
      );

      await expect(startInbox(source, 'file')).rejects.toThrow(/already being imported/);

      const runsAfter = await dataSource.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM ci_import.import_runs WHERE user_id = $1::uuid`,
        [userId],
      );

      expect(runsAfter[0].n).toBe(runsBefore[0].n);
    });

    it('releases the path when the run is cancelled before the move', async () => {
      const source = await seedInboxUnit('cancel-me.zip', 'file');
      const { run } = await startInbox(source, 'file');

      expect(await harness.service.cancel({ userId }, run.id)).toBe(true);
      expect((await rowByRunId(run.id))?.status).toBe('released');

      // The path is claimable again.
      const second = await startInbox(source, 'file');

      expect((await rowByRunId(second.run.id))?.status).toBe('claimed');
    });
  });

  describe('the upload claim', () => {
    it('claims by dropId, and a second claim conflicts', async () => {
      const { dropId } = await seedUpload('twice.zip');

      await startUpload(dropId);
      await expect(startUpload(dropId)).rejects.toThrow(/already been claimed/);
    });

    it('re-stages a claimed upload when its run fails before the move — never strands it', async () => {
      // THE upload-release rule. `released` would make the file invisible to
      // the uploads list, untouchable by the purge, and undeletable by the
      // user; re-staging puts it back on every one of those surfaces.
      const { dropId, sourcePath } = await seedUpload('fails.zip');
      const { run, stages } = await startUpload(dropId);

      await harness.service.failStage(stages[0].id, 'unreadable');

      const row = await rowByDropId(dropId);

      expect(row?.status).toBe('staged');
      expect(row?.run_id).toBeNull();
      expect(row?.expires_at).toBeInstanceOf(Date);
      // The bytes never left staging.
      expect((await stat(sourcePath)).size).toBe(5);
      // And the same dropId is importable again.
      const retry = await startUpload(dropId);

      expect(retry.run.id).not.toBe(run.id);
    });

    it('refuses an expired upload with the truth, not "already claimed"', async () => {
      const { dropId } = await seedUpload('expired.zip');

      await dataSource.query(
        `UPDATE ci_import.staged_sources SET status = 'expired' WHERE user_id = $1::uuid AND drop_id = $2`,
        [userId, dropId],
      );

      await expect(startUpload(dropId)).rejects.toThrow(/expired before it was imported/);
    });
  });

  describe('a claim whose run no longer exists', () => {
    it('is re-staged by the purge, and its bytes fall back under the TTL', async () => {
      const { dropId, sourcePath } = await seedUpload('orphaned.zip');
      const { run } = await startUpload(dropId);

      // `run_id` is ON DELETE SET NULL, so a run row deleted by anything other
      // than `ImportRetentionService.retireRun` — a restore, an operator's
      // DELETE — leaves the claim behind pointing at nothing.
      await dataSource.query(`DELETE FROM ci_import.import_runs WHERE id = $1::uuid`, [run.id]);

      expect(await rowByDropId(dropId)).toMatchObject({ status: 'claimed', run_id: null });

      // And in that state the archive is unreachable from every direction: not
      // in the uploads list, not deletable, not importable — the conflict names
      // a run that no longer exists.
      expect(await harness.stagedSources.listStagedUploads({ userId })).not.toContainEqual(
        expect.objectContaining({ dropId }),
      );
      expect(await harness.stagedSources.releaseUpload({ userId }, dropId)).toBe(false);
      await expect(startUpload(dropId)).rejects.toThrow(/already been claimed/);

      // The purge adopts it: same bytes, back in the staged pool, TTL running.
      await harness.stagedSources.purgeExpired();

      expect(await rowByDropId(dropId)).toMatchObject({ status: 'staged', run_id: null });
      expect((await stat(sourcePath)).size).toBe(5);
      expect(await harness.stagedSources.listStagedUploads({ userId })).toContainEqual(
        expect.objectContaining({ dropId }),
      );

      // Which is what makes it a backstop rather than a rename: once that
      // window elapses the ordinary sweep reclaims the bytes it was pinning.
      await dataSource.query(
        `UPDATE ci_import.staged_sources SET expires_at = now() - interval '1 hour'
          WHERE user_id = $1::uuid AND drop_id = $2`,
        [userId, dropId],
      );

      expect(await harness.stagedSources.purgeExpired()).toBeGreaterThanOrEqual(1);
      await expect(stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await rowByDropId(dropId))?.status).toBe('expired');
    });
  });

  describe('the move', () => {
    it('unpack moves an inbox directory out of the inbox into scratch and marks it moved', async () => {
      const source = await seedInboxUnit('takeout', 'directory');
      const { run, stages } = await startInbox(source, 'directory');
      const scratchDir = path.join(scratchParent, run.id);

      const outcome = await makeUnpackStage().run({
        userId,
        runId: run.id,
        stageId: stages[0].id,
        scratchDir,
        progress: async () => undefined,
      });

      expect(outcome.partial).toBe(false);
      await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(scratchDir, 'takeout', 'Mail', 'inbox.mbox'), 'utf8')).toBe('mail');
      expect((await rowByRunId(run.id))?.status).toBe('moved');

      await rm(scratchDir, { recursive: true, force: true });
    });

    it('unpack moves a staged upload the same way — one acquisition for both origins', async () => {
      const { dropId, sourcePath } = await seedUpload('upload-moves.bin');
      const { run, stages } = await startUpload(dropId);
      const scratchDir = path.join(scratchParent, run.id);

      await makeUnpackStage().run({
        userId,
        runId: run.id,
        stageId: stages[0].id,
        scratchDir,
        progress: async () => undefined,
      });

      // Consumed from staging — the file AND its now-empty <dropId>/ wrapper —
      // intact in scratch, registry says moved.
      await expect(stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(path.dirname(sourcePath))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(scratchDir, 'upload-moves.bin'), 'utf8')).toBe('bytes');
      expect((await rowByDropId(dropId))?.status).toBe('moved');

      await rm(scratchDir, { recursive: true, force: true });
    });

    it('a retried stage whose claim was released finds no source and fails honestly', async () => {
      const { dropId } = await seedUpload('released-retry.zip');
      const { run, stages } = await startUpload(dropId);

      // The run failed pre-move and the upload was re-staged...
      await harness.service.failStage(stages[0].id, 'unreadable');

      // ...so a stale retry of ITS stage must not acquire the re-staged file
      // (a newer run may own it by now).
      await expect(
        makeUnpackStage().run({
          userId,
          runId: run.id,
          stageId: stages[0].id,
          scratchDir: path.join(scratchParent, run.id),
          progress: async () => undefined,
        }),
      ).rejects.toThrow(/no claimed source/);
    });
  });

  describe('consumption', () => {
    it('marks the claim consumed when the run finishes having pulled records', async () => {
      const source = await seedInboxUnit('finishes.zip', 'file');
      const { run } = await startInbox(source, 'file');

      // A staged row, because `finishRun` asks `pulledRecords` before it stamps
      // `consumed`: a run that took nothing out of its source has not consumed
      // it, and stamping it would hand the user's only copy to the reclaim.
      await dataSource.query(
        `INSERT INTO ci_import.staged_items
           (run_id, user_id, data_source, classification, content_hash, occurred_at, metadata)
         VALUES ($1::uuid, $2::uuid, 'generic', 'note', 'consume-1', now(), '{}'::jsonb)`,
        [run.id, userId],
      );

      await dataSource.query(
        `UPDATE ci_import.import_stages SET status = 'completed', finished_at = now() WHERE run_id = $1::uuid`,
        [run.id],
      );
      await harness.service.finishRun(run.id);

      expect((await rowByRunId(run.id))?.status).toBe('consumed');
    });

    it('releases rather than consumes when the run staged nothing at all', async () => {
      // The data-loss guard from the consolidation audit: an inbox unit no
      // parser recognized still closes `partial`, and `consumed` would send the
      // user's only copy out with the scratch tree.
      const source = await seedInboxUnit('recognized-by-nobody.zip', 'file');
      const { run } = await startInbox(source, 'file');

      await dataSource.query(
        `UPDATE ci_import.import_stages SET status = 'completed', finished_at = now() WHERE run_id = $1::uuid`,
        [run.id],
      );
      await harness.service.finishRun(run.id);

      expect((await rowByRunId(run.id))?.status).toBe('released');
    });

    it('never releases a claim that already moved — the bytes wait in scratch for a retry', async () => {
      const source = await seedInboxUnit('moved-then-failed', 'directory');
      const { run, stages } = await startInbox(source, 'directory');

      await dataSource.query(`UPDATE ci_import.staged_sources SET status = 'moved' WHERE run_id = $1::uuid`, [
        run.id,
      ]);

      await harness.service.failStage(stages[1].id, 'parser choked');

      expect((await rowByRunId(run.id))?.status).toBe('moved');
    });
  });
});
