import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import config from '@ci/configuration';

import type { ImportStageKindName } from '../constants';
import { ImportRetentionService } from '../services/ImportRetentionService';
import { ImportScratchService } from '../services/ImportScratchService';
import { StagedWriter } from '../staging/StagedWriter';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IMPORT RETENTION, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything this sweep does is a `DELETE` and a foreign-key cascade, so a
 * mocked repository would agree with whatever the spec author believed about
 * both. `staged_relationships` cascades from `staged_items` AND
 * `staged_entities`, `entity_mappings` cascades from `staged_entities`, and
 * `import_stages` cascades from `import_runs` — four cascade edges whose whole
 * value is that the service does not have to name them. Asserting that against
 * a stub is asserting nothing.
 *
 * The two halves under test are the two windows:
 *
 *  - `stagingDays` — the scratchpad goes, the run row and its stages stay, so
 *    the import UI still renders the history.
 *  - `runHistoryDays` — the run row goes and takes everything with it.
 *
 * and, more important than either, the four things the sweep must never take:
 * a live run, a recent run, a run with resumable work (`pending`/`failed`
 * staged rows), and a run whose bytes still exist only on disk.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/importRetention.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

type Retention = (typeof config.import)['retention'];

const DAY_MS = 24 * 60 * 60 * 1000;

describeWithDatabase(`import retention (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let dataSource: DataSource;
  let userId: string;
  let retention: ImportRetentionService;
  let scratch: ImportScratchService;
  let scratchRoot: string;
  let originalRetention: Retention;
  let originalScratchDir: string;
  /**
   * The sweep's own logger, kept rather than discarded: the skip REASONS are
   * reported per run only in these calls (the result carries bare counts), and
   * counts cannot be asserted on here — the sweep is global, and sibling suites
   * running against the same database contribute immortal runs of their own.
   */
  let sweepLog: { warn: jest.Mock };

  const stubLogger = () => ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  });

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());
    ({ dataSource, userId } = harness);

    scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'ci-import-retention-'));

    originalRetention = config.import.retention;
    originalScratchDir = config.import.scratchDir;
    // A real directory this spec owns, so `ImportScratchService.exists` answers
    // about bytes the spec created rather than about the appliance's own tree.
    (config.import as { scratchDir: string }).scratchDir = scratchRoot;

    scratch = new ImportScratchService(stubLogger() as never);
    sweepLog = stubLogger();
    retention = new ImportRetentionService(dataSource, scratch, sweepLog as never);
  });

  afterAll(async () => {
    (config.import as { retention: Retention }).retention = originalRetention;
    (config.import as { scratchDir: string }).scratchDir = originalScratchDir;

    await rm(scratchRoot, { recursive: true, force: true });

    // This spec seeds source rows the harness does not track (an inbox unit,
    // an upload it re-points at a run) and its sweeps deliberately leave some
    // of them behind, so it clears its own user's registry before teardown.
    await dataSource.query(`DELETE FROM ci_import.staged_sources WHERE user_id = $1::uuid`, [userId]);

    await teardown();
  });

  beforeEach(() => {
    setRetention({});
  });

  function setRetention(overrides: Partial<Retention>): void {
    (config.import as { retention: Retention }).retention = {
      enabled: true,
      stagingDays: 7,
      runHistoryDays: 90,
      maxRunsPerSweep: 200,
      deleteBatchSize: 5000,
      ...overrides,
    };
  }

  // ── seeding ───────────────────────────────────────────────────────────────

  /**
   * A run with a full staging payload: two items, an entity, an item→entity
   * edge, an item→item edge, and an entity mapping. Every cascade edge in the
   * schema is represented, so a sweep that deletes only what it names leaves
   * something behind and the counts say so.
   */
  async function seedRun(
    options: { classification?: string; stages?: readonly ImportStageKindName[] } = {},
  ): Promise<string> {
    // Explicit stages so the stage count is a constant this spec can assert on
    // rather than whatever the default list happens to be.
    const { run } = await harness.startRunForDrop(
      await harness.stageDrop('export.zip'),
      options.stages ?? ['unpack', 'parse', 'push'],
    );
    const runId = run.id;
    const writer = new StagedWriter(dataSource.manager, { userId, runId, dataSource: 'google_photos' });

    for (const name of ['one', 'two']) {
      writer.push({
        item: {
          // NOT a file classification by default: `photo`/`media`/`file` and
          // friends make `hasUnstoredMedia` true for any row with a location,
          // which is a guard this spec exercises deliberately and must not
          // trip over by accident.
          classification: options.classification ?? 'generic',
          timestamp: new Date('2012-07-04T10:00:00Z'),
          content: { filename: `${name}-${runId.slice(0, 8)}.jpg` },
          intermediateLocation: 'Photos from 2012/',
        },
      });
    }

    await writer.settled();

    const items = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM ci_import.staged_items WHERE run_id = $1::uuid ORDER BY id`,
      [runId],
    );

    expect(items).toHaveLength(2);

    const [entity] = await dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ci_import.staged_entities (run_id, user_id, type, name, identity_key, push_status)
       VALUES ($1::uuid, $2::uuid, 'Person', 'Ada', $3, 'pushed')
       RETURNING id`,
      [runId, userId, `ada-${runId}`],
    );

    await dataSource.query(
      `INSERT INTO ci_import.staged_relationships (run_id, item_id, entity_id, relation)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'depicts')`,
      [runId, items[0].id, entity.id],
    );
    await dataSource.query(
      `INSERT INTO ci_import.staged_relationships (run_id, item_id, related_item_id, relation)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'album')`,
      [runId, items[0].id, items[1].id],
    );
    await dataSource.query(
      `INSERT INTO ci_import.entity_mappings (staged_entity_id, user_id, server_entity_id)
       VALUES ($1::uuid, $2::uuid, gen_random_uuid())`,
      [entity.id, userId],
    );

    return runId;
  }

  /** Put every staged row of a run into a terminal push state. */
  async function drain(runId: string, status: 'pushed' | 'skipped' | 'failed' = 'pushed'): Promise<void> {
    for (const table of ['staged_items', 'staged_entities']) {
      await dataSource.query(
        `UPDATE ci_import.${table} SET push_status = $2, pushed_at = now() WHERE run_id = $1::uuid`,
        [runId, status],
      );
    }
  }

  /**
   * Close the run the way the stage runners do — every stage terminal, the run
   * row terminal — and then age it.
   */
  async function finish(runId: string, daysAgo: number, status = 'completed'): Promise<void> {
    const at = new Date(Date.now() - daysAgo * DAY_MS);

    await dataSource.query(
      `UPDATE ci_import.import_stages
          SET status = 'completed', finished_at = $2, updated_at = $2
        WHERE run_id = $1::uuid`,
      [runId, at],
    );
    await dataSource.query(
      `UPDATE ci_import.import_runs
          SET status = $3, percent = 100, finished_at = $2, updated_at = $2
        WHERE id = $1::uuid`,
      [runId, at, status],
    );
  }

  /**
   * A run whose unpack failed, closed by `failStage` itself: the run `failed`
   * and finished, the stages after the unpack left `queued` for a retry.
   * Nothing is staged, because nothing was extracted. Then aged.
   */
  async function failedUnpackRun(daysAgo: number): Promise<string> {
    const { run, stages } = await harness.startRunForDrop(await harness.stageDrop('truncated.zip'), [
      'unpack',
      'parse',
      'push',
    ]);
    const unpack = stages.find((stage) => stage.kind === 'unpack');
    const at = new Date(Date.now() - daysAgo * DAY_MS);

    await harness.service.failStage(unpack!.id, 'cannot unpack truncated.zip: the file is truncated');
    await dataSource.query(
      `UPDATE ci_import.import_runs SET finished_at = $2, updated_at = $2 WHERE id = $1::uuid`,
      [run.id, at],
    );

    return run.id;
  }

  /** The run's stage statuses, in pipeline order. */
  async function stageStatuses(runId: string): Promise<string[]> {
    const rows = await dataSource.query<Array<{ status: string }>>(
      `SELECT status FROM ci_import.import_stages WHERE run_id = $1::uuid ORDER BY seq`,
      [runId],
    );

    return rows.map((row) => row.status);
  }

  /** A drained, closed, aged run — the ordinary retention candidate. */
  async function retiredRun(daysAgo: number, status = 'completed'): Promise<string> {
    const runId = await seedRun();

    await drain(runId);
    await finish(runId, daysAgo, status);

    return runId;
  }

  // ── counting ──────────────────────────────────────────────────────────────

  async function counts(runId: string): Promise<Record<string, number>> {
    const [row] = await dataSource.query<Array<Record<string, number>>>(
      `SELECT (SELECT count(*)::int FROM ci_import.import_runs WHERE id = $1::uuid) AS runs,
              (SELECT count(*)::int FROM ci_import.import_stages WHERE run_id = $1::uuid) AS stages,
              (SELECT count(*)::int FROM ci_import.staged_items WHERE run_id = $1::uuid) AS items,
              (SELECT count(*)::int FROM ci_import.staged_entities WHERE run_id = $1::uuid) AS entities,
              (SELECT count(*)::int FROM ci_import.staged_relationships WHERE run_id = $1::uuid) AS relationships,
              (SELECT count(*)::int FROM ci_import.entity_mappings m
                 JOIN ci_import.staged_entities e ON e.id = m.staged_entity_id
                WHERE e.run_id = $1::uuid) AS mappings`,
      [runId],
    );

    return row;
  }

  /**
   * One `staged_sources` row by whatever still identifies it once its run is
   * gone — an upload's handle, an inbox unit's path. Deliberately not keyed on
   * `run_id`: the column is `ON DELETE SET NULL`, so a row that survives its
   * run is exactly the row this cannot find that way.
   */
  async function sourceRow(key: string): Promise<{ status: string; runId: string | null } | null> {
    const [row] = await dataSource.query<Array<{ status: string; runId: string | null }>>(
      `SELECT status, run_id AS "runId"
         FROM ci_import.staged_sources
        WHERE drop_id = $1 OR source_path = $1`,
      [key],
    );

    return row ?? null;
  }

  /** The same row with the fields a re-stage rewrites, for the tests that read them. */
  async function sourceDetail(
    key: string,
  ): Promise<{ status: string; runId: string | null; claimedAt: Date | null; expiresAt: Date | null }> {
    const [row] = await dataSource.query<
      Array<{ status: string; runId: string | null; claimedAt: Date | null; expiresAt: Date | null }>
    >(
      `SELECT status, run_id AS "runId", claimed_at AS "claimedAt", expires_at AS "expiresAt"
         FROM ci_import.staged_sources
        WHERE drop_id = $1 OR source_path = $1`,
      [key],
    );

    return row;
  }

  /** The run's own status column, for the tests that care what a refusal left behind. */
  async function runStatus(runId: string): Promise<string | null> {
    const [row] = await dataSource.query<Array<{ status: string }>>(
      `SELECT status FROM ci_import.import_runs WHERE id = $1::uuid`,
      [runId],
    );

    return row?.status ?? null;
  }

  /** The run's `updated_at`, for the tests that assert a write did not touch it. */
  async function runUpdatedAt(runId: string): Promise<Date | null> {
    const [row] = await dataSource.query<Array<{ updatedAt: Date }>>(
      `SELECT updated_at AS "updatedAt" FROM ci_import.import_runs WHERE id = $1::uuid`,
      [runId],
    );

    return row?.updatedAt ?? null;
  }

  /** A run's staged item ids, in the order {@link seedRun} created them. */
  async function stagedItemIds(runId: string): Promise<string[]> {
    const rows = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM ci_import.staged_items WHERE run_id = $1::uuid ORDER BY id`,
      [runId],
    );

    return rows.map((row) => row.id);
  }

  /**
   * Stamp one staged row's metadata the way `MediaStage` does — merged, not
   * replaced, because the keys it writes sit alongside whatever the parser left.
   */
  async function stampMetadata(itemId: string, patch: Record<string, unknown>): Promise<void> {
    await dataSource.query(
      `UPDATE ci_import.staged_items
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1::uuid`,
      [itemId, JSON.stringify(patch)],
    );
  }

  /** The handle of the upload a harness run claimed. */
  async function uploadDropFor(runId: string): Promise<string> {
    const [row] = await dataSource.query<Array<{ dropId: string }>>(
      `SELECT drop_id AS "dropId" FROM ci_import.staged_sources
        WHERE run_id = $1::uuid AND origin = 'upload'`,
      [runId],
    );

    return row.dropId;
  }

  const FULL = { runs: 1, stages: 3, items: 2, entities: 1, relationships: 2, mappings: 1 };
  const HISTORY_ONLY = { runs: 1, stages: 3, items: 0, entities: 0, relationships: 0, mappings: 0 };
  const GONE = { runs: 0, stages: 0, items: 0, entities: 0, relationships: 0, mappings: 0 };

  // ── what goes ─────────────────────────────────────────────────────────────

  describe('the staging window', () => {
    it('reclaims the payload of a drained run and keeps its history', async () => {
      const runId = await retiredRun(30);

      expect(await counts(runId)).toEqual(FULL);

      const result = await retention.sweep();

      expect(await counts(runId)).toEqual(HISTORY_ONLY);
      expect(result.payloadPurgedRuns).toBeGreaterThanOrEqual(1);
      expect(result.runsDeleted).toBe(0);
    });

    it('leaves history queryable — the run list reads stages, never staged rows', async () => {
      const runId = await retiredRun(30);

      await retention.sweep();

      const [row] = await dataSource.query<Array<{ status: string; percent: number }>>(
        `SELECT status, percent FROM ci_import.import_runs WHERE id = $1::uuid`,
        [runId],
      );

      expect(row).toEqual({ status: 'completed', percent: 100 });
      expect((await harness.service.stagesFor(runId)).length).toBe(3);
    });

    it('takes a partial run too — a partly-parsed export is terminal, not broken', async () => {
      const runId = await retiredRun(30, 'partial');

      await retention.sweep();

      expect(await counts(runId)).toEqual(HISTORY_ONLY);
    });

    it('does not re-select a run whose payload is already gone', async () => {
      await retiredRun(30);

      expect((await retention.sweep()).payloadPurgedRuns).toBeGreaterThanOrEqual(1);
      expect((await retention.sweep()).payloadPurgedRuns).toBe(0);
    });
  });

  describe('the history window', () => {
    it('deletes the run and cascades everything still hanging off it', async () => {
      const runId = await retiredRun(200);

      const result = await retention.sweep();

      expect(await counts(runId)).toEqual(GONE);
      expect(result.runsDeleted).toBeGreaterThanOrEqual(1);
    });

    it('is the backstop for a run the staging sweep declined — failed rows and all', async () => {
      const runId = await seedRun();

      await drain(runId, 'failed');
      await finish(runId, 200);

      // Inside the staging window's rules this run is untouchable: `failed`
      // rows are what retryFailedPush exists for.
      setRetention({ runHistoryDays: 365 });
      await retention.sweep();
      expect(await counts(runId)).toEqual(FULL);

      // Past the history window it goes anyway, so a retry nobody ran cannot
      // pin a payload open forever.
      setRetention({});
      await retention.sweep();
      expect(await counts(runId)).toEqual(GONE);
    });

    it('collects a run whose unpack failed — the stages queued after it are leftovers', async () => {
      const runId = await failedUnpackRun(200);

      // The premise: `failStage` closes the run and leaves the later stages
      // `queued`, where a retry can pick them up. No worker will reach them.
      expect(await runStatus(runId)).toBe('failed');
      expect(await stageStatuses(runId)).toEqual(['failed', 'queued', 'queued']);

      await retention.sweep();

      expect(await counts(runId)).toEqual(GONE);
    });

    it('keeps that run once its unpack is retried, because the retry reopens it', async () => {
      const runId = await failedUnpackRun(200);
      const [unpack] = await dataSource.query<Array<{ id: string }>>(
        `SELECT id FROM ci_import.import_stages WHERE run_id = $1::uuid AND kind = 'unpack'`,
        [runId],
      );

      expect(await harness.service.retryStage({ userId }, runId, unpack.id)).toBe(true);
      // The requeue and the reopen land together. The run is open again, so the
      // sweep counts its queued stages as live.
      expect(await runStatus(runId)).toBe('queued');
      expect(await stageStatuses(runId)).toEqual(['queued', 'queued', 'queued']);

      await retention.sweep();

      expect(await counts(runId)).toEqual({ ...GONE, runs: 1, stages: 3 });
    });

    it('takes the retired run’s spent source rows with it', async () => {
      const runId = await retiredRun(200);
      const dropId = await uploadDropFor(runId);

      // What `finishRun` stamps on a run that pulled records: the archive went
      // into the run's scratch tree and was reclaimed with it.
      await harness.stagedSources.markConsumed(runId);

      // A second unit the same run unpacked. Inbox, so it has no handle at all
      // — the run id was the only thing identifying it, and `ON DELETE SET
      // NULL` used to take even that.
      const inboxPath = `/nonexistent/inbox/${runId}/unit`;

      await dataSource.query(
        `INSERT INTO ci_import.staged_sources (user_id, origin, source_path, kind, status, run_id)
         VALUES ($1::uuid, 'inbox', $2, 'directory', 'moved', $3::uuid)`,
        [userId, inboxPath, runId],
      );

      const result = await retention.sweep();

      expect(await counts(runId)).toEqual(GONE);
      expect(await sourceRow(dropId)).toBeNull();
      expect(await sourceRow(inboxPath)).toBeNull();
      expect(result.sourceRowsDeleted).toBeGreaterThanOrEqual(2);
    });

    it('hands a claimed upload back to its owner rather than orphaning it', async () => {
      // The crash window nothing else covers: a run reached a terminal state
      // without `finishRun` ever stamping its source, so the claim outlived the
      // work. Retiring the run used to leave that row behind with a null run id
      // — an archive its owner could not see in the uploads list, could not
      // delete, and could not import (`startRun` answers "already claimed by
      // another import run" about a run that no longer exists), and whose bytes
      // no sweep would ever take.
      const runId = await retiredRun(200);
      const dropId = await uploadDropFor(runId);

      expect(await sourceRow(dropId)).toEqual({ status: 'claimed', runId });

      const result = await retention.sweep();

      expect(await counts(runId)).toEqual(GONE);

      // Back on every surface the claim took it off.
      const restaged = await sourceDetail(dropId);

      expect(restaged).toMatchObject({ status: 'staged', runId: null, claimedAt: null });
      expect(restaged.expiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(result.uploadsRestaged).toBeGreaterThanOrEqual(1);
      expect(await harness.stagedSources.listStagedUploads({ userId })).toContainEqual(
        expect.objectContaining({ dropId }),
      );
    });

    it('takes a claimed inbox row with the run — that unit is claimable again', async () => {
      const runId = await retiredRun(200);
      const inboxPath = `/nonexistent/inbox/${runId}/still-claimed`;

      await dataSource.query(
        `INSERT INTO ci_import.staged_sources
           (user_id, origin, source_path, kind, status, run_id, claimed_at)
         VALUES ($1::uuid, 'inbox', $2, 'directory', 'claimed', $3::uuid, now())`,
        [userId, inboxPath, runId],
      );

      await retention.sweep();

      // An inbox row is only a claim on a file that never left the user's own
      // folder, so there is nothing here to hand back — and keeping it would
      // hold `staged_sources_active_path_uq` against that path forever.
      expect(await sourceRow(inboxPath)).toBeNull();

      // Which the index is the proof of: the same path claims cleanly again.
      const nextRunId = await seedRun();

      await expect(
        dataSource.query(
          `INSERT INTO ci_import.staged_sources
             (user_id, origin, source_path, kind, status, run_id, claimed_at)
           VALUES ($1::uuid, 'inbox', $2, 'directory', 'claimed', $3::uuid, now())`,
          [userId, inboxPath, nextRunId],
        ),
      ).resolves.not.toThrow();
    });

    it('leaves an upload the user still holds — even one naming the retired run', async () => {
      const runId = await retiredRun(200);

      await harness.stagedSources.markConsumed(runId);

      // Still `staged`: its archive is sitting in the uploads directory this
      // second. Pointed at the retired run so nothing but the STATUS can save
      // it — which is what `run_id ON DELETE SET NULL` is there to protect.
      const heldDropId = await harness.stageDrop('still-held.zip');

      await dataSource.query(`UPDATE ci_import.staged_sources SET run_id = $1::uuid WHERE drop_id = $2`, [
        runId,
        heldDropId,
      ]);

      const before = await sourceDetail(heldDropId);

      await retention.sweep();

      expect(await counts(runId)).toEqual(GONE);
      expect(await sourceRow(heldDropId)).toEqual({ status: 'staged', runId: null });
      // Untouched, not merely still staged: a re-stage rewrites the TTL, and
      // this row's window is the user's own upload window.
      expect((await sourceDetail(heldDropId)).expiresAt).toEqual(before.expiresAt);
    });
  });

  // ── what stays ────────────────────────────────────────────────────────────

  describe('what the sweep must never take', () => {
    it('leaves a run with work still in flight', async () => {
      const runId = await seedRun();

      await drain(runId);
      // Aged well past both windows, but never closed: `finished_at` is NULL
      // and a stage is still queued.
      await dataSource.query(
        `UPDATE ci_import.import_runs
            SET status = 'running', created_at = now() - interval '400 days',
                updated_at = now() - interval '400 days'
          WHERE id = $1::uuid`,
        [runId],
      );

      await retention.sweep();

      // Asserted about THIS run rather than about the sweep's totals: the
      // sweep is global, and a sibling test's run is not this test's subject.
      expect(await counts(runId)).toEqual(FULL);
    });

    it('leaves the claimed upload of a run still in flight', async () => {
      const runId = await seedRun();
      const dropId = await uploadDropFor(runId);

      await drain(runId);
      // Aged past both windows and never closed, exactly as above — but read
      // here for the SOURCE row, because re-staging an upload whose unpack is
      // about to move it would hand the same bytes to a second run.
      await dataSource.query(
        `UPDATE ci_import.import_runs
            SET status = 'running', created_at = now() - interval '400 days',
                updated_at = now() - interval '400 days'
          WHERE id = $1::uuid`,
        [runId],
      );

      await retention.sweep();

      expect(await counts(runId)).toEqual(FULL);
      expect(await sourceRow(dropId)).toEqual({ status: 'claimed', runId });
    });

    it('leaves a run whose status is terminal but whose stages are not', async () => {
      const runId = await retiredRun(200);

      // The status column is a derived cache. A stage still `running` means
      // work is in flight whatever the cache says.
      await dataSource.query(
        `UPDATE ci_import.import_stages SET status = 'running'
          WHERE id = (SELECT id FROM ci_import.import_stages WHERE run_id = $1::uuid ORDER BY seq DESC LIMIT 1)`,
        [runId],
      );

      await retention.sweep();

      expect(await counts(runId)).toEqual(FULL);
    });

    it('leaves a recently finished run alone', async () => {
      const runId = await retiredRun(1);

      await retention.sweep();

      expect(await counts(runId)).toEqual(FULL);
    });

    it('leaves a run whose rows are still pending — that is the Sync card’s backlog', async () => {
      const runId = await seedRun();

      await drain(runId);
      await dataSource.query(
        `UPDATE ci_import.staged_items SET push_status = 'pending', pushed_at = NULL
          WHERE run_id = $1::uuid`,
        [runId],
      );
      await finish(runId, 30);

      await retention.sweep();

      expect(await counts(runId)).toEqual(FULL);
    });

    it('leaves a run whose rows failed — that is what retryFailedPush reads', async () => {
      const runId = await seedRun();

      await drain(runId, 'failed');
      await finish(runId, 30);

      await retention.sweep();

      expect(await counts(runId)).toEqual(FULL);
    });

    it('leaves a run still holding media whose bytes were never stored', async () => {
      // A staged photo with an intermediate location and no FileId: its bytes
      // exist only in the scratch tree, and this row is the record of that.
      const runId = await seedRun({ classification: 'photo' });

      await drain(runId);
      await finish(runId, 200);

      expect(await harness.service.hasUnstoredMedia(runId)).toBe(true);

      const result = await retention.sweep();

      expect(await counts(runId)).toEqual(FULL);
      expect(result.skipped.unstored_media).toBeGreaterThanOrEqual(1);
    });

    it('leaves a run that still owns a scratch tree — its row is the only index into those bytes', async () => {
      const runId = await retiredRun(200);

      await mkdir(scratch.dirFor(userId, runId), { recursive: true });

      const result = await retention.sweep();

      expect(await counts(runId)).toEqual(FULL);
      expect(result.skipped.scratch_tree_present).toBeGreaterThanOrEqual(1);

      // And once the tree is reclaimed, the same run retires normally.
      await rm(scratch.dirFor(userId, runId), { recursive: true, force: true });
      await retention.sweep();
      expect(await counts(runId)).toEqual(GONE);
    });
  });

  /**
   * The wizard's shape: `[unpack, parse]` only, its rows still `pending`, and
   * no push stage — so `PUSH_ELIGIBLE_WHERE` offers it on the Sync card. That
   * offer carries no age bound, which is why the sweep's must not either.
   */
  const PARSED_STAGES = ['unpack', 'parse'] as const;
  const PARSED_FULL = { ...FULL, stages: 2 };

  async function parsedNeverPushedRun(daysAgo: number): Promise<string> {
    const runId = await seedRun({ stages: PARSED_STAGES });

    await finish(runId, daysAgo);

    return runId;
  }

  describe('a parse that was never pushed', () => {
    it('survives the history window — deleting it would destroy the only copy', async () => {
      const runId = await parsedNeverPushedRun(200);

      // The premise, asserted rather than assumed: Sync is offering this run.
      expect(await harness.service.listUnpushed({ userId })).toContainEqual(
        expect.objectContaining({ run: expect.objectContaining({ id: runId }) }),
      );

      const result = await retention.sweep();

      expect(await counts(runId)).toEqual(PARSED_FULL);
      // And the offer is still honest afterwards.
      expect(await harness.service.listUnpushed({ userId })).toContainEqual(
        expect.objectContaining({ run: expect.objectContaining({ id: runId }) }),
      );
      expect(result.skipped.push_pending).toBeGreaterThanOrEqual(1);
    });

    it('survives at any TTL — the exception is the payload, not the dial', async () => {
      const runId = await parsedNeverPushedRun(200);

      setRetention({ stagingDays: 0, runHistoryDays: 0 });
      await retention.sweep();

      expect(await counts(runId)).toEqual(PARSED_FULL);
    });

    it('but the same run goes once its rows are pushed — nothing is left to offer', async () => {
      const runId = await parsedNeverPushedRun(200);

      // The ONLY difference from the run above. If the guard were "any parsed
      // run is immortal" rather than "a pushable payload is", this would stay.
      await drain(runId);

      await retention.sweep();

      // Run-scoped, not a sweep total: the two runs above are immortal by
      // design and are still in this database, being skipped every sweep.
      expect(await counts(runId)).toEqual(GONE);
    });
  });

  /**
   * The other half of the exception above: the run age never takes, its owner
   * can. Everything here is asserted per RUN rather than off a sweep total,
   * for the reason `sweepLog` documents.
   */
  describe('discarding an abandoned parse', () => {
    /** Runs the sweep named under `push_pending` on its most recent pass. */
    function pushPendingRunIds(): string[] {
      return sweepLog.warn.mock.calls
        .map(([, detail]) => detail as { reason?: string; runId?: string })
        .filter((detail) => detail?.reason === 'push_pending')
        .map((detail) => detail.runId as string);
    }

    it('takes the whole parse, and the sweep stops reporting it', async () => {
      const runId = await parsedNeverPushedRun(200);
      const dropId = await uploadDropFor(runId);

      await harness.stagedSources.markConsumed(runId);

      // The premise: this run is exactly the one the sweep can never collect.
      sweepLog.warn.mockClear();
      await retention.sweep();
      expect(pushPendingRunIds()).toContain(runId);

      const discarded = await retention.discardRun({ userId }, runId);

      expect(discarded).toEqual({
        runId,
        label: expect.any(String),
        // Two staged items and one staged entity; the relationships and the
        // entity mapping ride the cascade rather than being counted.
        stagedRowsDeleted: 3,
        sourceRowsDeleted: 1,
        uploadsRestaged: 0,
        // This run's media stage stored nothing, and the reply says so rather
        // than omitting the question — see the media test below.
        mediaFilesKept: 0,
        attachmentContentsKept: 0,
      });
      expect(await counts(runId)).toEqual(GONE);
      // Its consumed upload registry row went with it — the same retirement the
      // history sweep performs, not a second delete path that forgot it.
      expect(await sourceRow(dropId)).toBeNull();
      // And the Sync card no longer offers a push over rows that are gone.
      expect(await harness.service.listUnpushed({ userId })).not.toContainEqual(
        expect.objectContaining({ run: expect.objectContaining({ id: runId }) }),
      );

      sweepLog.warn.mockClear();
      await retention.sweep();
      expect(pushPendingRunIds()).not.toContain(runId);
    });

    it('gives the archive back — discarding a parse is not discarding the export', async () => {
      const runId = await parsedNeverPushedRun(200);
      // Still `claimed`: the run never consumed it, so those bytes are sitting
      // in the uploads directory and are not this discard's to destroy.
      const dropId = await uploadDropFor(runId);

      expect(await retention.discardRun({ userId }, runId)).toMatchObject({
        sourceRowsDeleted: 0,
        uploadsRestaged: 1,
      });
      expect(await counts(runId)).toEqual(GONE);
      expect(await sourceRow(dropId)).toEqual({ status: 'staged', runId: null });
    });

    it('does not wait for a window — age is not what makes a parse unwanted', async () => {
      const runId = await parsedNeverPushedRun(0);

      expect(await retention.discardRun({ userId }, runId)).toMatchObject({ runId });
      expect(await counts(runId)).toEqual(GONE);
    });

    it('will not take another user’s run — that is a 404, not a refusal', async () => {
      const runId = await parsedNeverPushedRun(200);

      expect(await retention.discardRun({ userId: randomUUID() }, runId)).toBeNull();
      expect(await counts(runId)).toEqual(PARSED_FULL);
    });

    it('refuses a run with nothing on offer — retention already collects that one', async () => {
      const runId = await retiredRun(200);

      await expect(retention.discardRun({ userId }, runId)).rejects.toBeInstanceOf(ConflictException);
      expect(await counts(runId)).toEqual(FULL);
    });

    it('does not call a run whose unpack failed "still working" — it says there is nothing to discard', async () => {
      const runId = await failedUnpackRun(0);
      const refusal = retention.discardRun({ userId }, runId);

      // The later stages are still `queued`, but the run is over: the refusal
      // is the honest one (no parse to release), not "cancel it first" for a
      // run that cancel answers 404 about.
      await expect(refusal).rejects.toBeInstanceOf(ConflictException);
      await expect(refusal).rejects.toThrow(/has no parse waiting to be pushed/);
      expect(await runStatus(runId)).toBe('failed');
    });

    it('tells a failed run that still holds its scratch tree about the tree, not that retention will collect it', async () => {
      // What a worker leaves behind: the failure path never reclaims the tree,
      // and `UnpackStage` has already moved the upload into it. The sweep skips
      // such a run, so "retention collects this run" would be untrue.
      const runId = await failedUnpackRun(0);

      await mkdir(scratch.dirFor(userId, runId), { recursive: true });

      const refusal = retention.discardRun({ userId }, runId);

      await expect(refusal).rejects.toBeInstanceOf(ConflictException);
      await expect(refusal).rejects.toThrow(/still owns a scratch tree/);
      expect(await runStatus(runId)).toBe('failed');

      await rm(scratch.dirFor(userId, runId), { recursive: true, force: true });
    });

    it('refuses a run whose stages are still live, whatever the status column says', async () => {
      const runId = await parsedNeverPushedRun(200);

      // The status cache stays terminal; a stage does not. Deleting the run
      // here would leave a worker writing to rows that no longer exist.
      //
      // `unpack`, deliberately: putting the PARSE stage back to running would
      // also make the run un-pushable, so the refusal would prove the other
      // guard and this one could be deleted without a test noticing.
      await dataSource.query(
        `UPDATE ci_import.import_stages SET status = 'running'
          WHERE run_id = $1::uuid AND kind = 'unpack'`,
        [runId],
      );

      await expect(retention.discardRun({ userId }, runId)).rejects.toBeInstanceOf(ConflictException);
      expect(await counts(runId)).toEqual(PARSED_FULL);
    });

    it('refuses a run that still owns a scratch tree — its row indexes those bytes', async () => {
      const runId = await parsedNeverPushedRun(200);

      await mkdir(scratch.dirFor(userId, runId), { recursive: true });

      await expect(retention.discardRun({ userId }, runId)).rejects.toBeInstanceOf(ConflictException);
      expect(await counts(runId)).toEqual(PARSED_FULL);

      // And once the tree is gone, the same run discards normally.
      await rm(scratch.dirFor(userId, runId), { recursive: true, force: true });
      expect(await retention.discardRun({ userId }, runId)).toMatchObject({ runId });
      expect(await counts(runId)).toEqual(GONE);
    });

    it('refuses a run whose staged media exists only on disk — in SQL, not by inference', async () => {
      // The sweep applies `unstoredMediaExistsSql` in all four of its candidate
      // queries. Until the discard asked the same question itself it was safe
      // only because `ImportStageListener` keeps the scratch tree for such a run
      // and the tree guard then refuses — a two-component invariant with nothing
      // asserting it. Here the tree is absent and the rule still holds.
      const runId = await seedRun({ stages: PARSED_STAGES, classification: 'photo' });

      await finish(runId, 200);

      expect(await harness.service.hasUnstoredMedia(runId)).toBe(true);
      expect(await scratch.exists(userId, runId)).toBe(false);

      await expect(retention.discardRun({ userId }, runId)).rejects.toBeInstanceOf(ConflictException);
      expect(await counts(runId)).toEqual(PARSED_FULL);
      // A refusal leaves the run exactly as it was found — still terminal, still
      // on the Sync card. Nothing is stamped before every guard has passed.
      expect(await runStatus(runId)).toBe('completed');

      // And once the media stage has stored those bytes, the same run discards.
      for (const id of await stagedItemIds(runId)) {
        await stampMetadata(id, { FileId: randomUUID() });
      }

      expect(await retention.discardRun({ userId }, runId)).toMatchObject({ runId, mediaFilesKept: 2 });
      expect(await counts(runId)).toEqual(GONE);
    });

    /**
     * The half a discard cannot take back, and therefore has to declare.
     *
     * The wizard starts every run as `['unpack', 'parse', 'media']`, so by the
     * time the Sync card can list one its media stage has already written
     * `ci.files` rows (bytes in the object store) and `ci.content` rows over
     * message attachments. No cascade from `import_runs` reaches `ci.*`, and
     * `staged_items.metadata` is the last thing naming them — which this
     * deletes. Counting after the delete is impossible, so a reply that did not
     * carry these numbers could never be made to.
     */
    it('counts the media it already stored, distinctly, before deleting what names it', async () => {
      const runId = await parsedNeverPushedRun(200);
      const [photo, message] = await stagedItemIds(runId);
      const sharedFile = randomUUID();

      await stampMetadata(photo, { FileId: sharedFile });
      // A message carrying two attachments, one of which is the SAME file: the
      // object store dedups on the bytes, so a per-reference count would report
      // three files the user does not have.
      await stampMetadata(message, {
        AttachmentFileIds: [sharedFile, randomUUID()],
        AttachmentContentIds: [randomUUID(), randomUUID()],
      });

      expect(await retention.discardRun({ userId }, runId)).toMatchObject({
        mediaFilesKept: 2,
        attachmentContentsKept: 2,
      });
      expect(await counts(runId)).toEqual(GONE);
    });

    it('takes the run off the Sync card before it deletes a row of it', async () => {
      const runId = await parsedNeverPushedRun(200);
      const agedAt = await runUpdatedAt(runId);
      const failure = new Error('the appliance lost power mid-delete');
      // The payload delete is batched and auto-committed per batch, so it can
      // never be atomic with the decision to make it. What has to be atomic is
      // the run ceasing to be pushable.
      const crash = jest
        .spyOn(retention as unknown as { deletePayload(runId: string): Promise<number> }, 'deletePayload')
        .mockRejectedValueOnce(failure);

      await expect(retention.discardRun({ userId }, runId)).rejects.toBe(failure);

      crash.mockRestore();

      // Every staged row survived this particular crash — but a crash one batch
      // later would not have, and the assertion that matters is the same either
      // way: nothing is offering to push what is being destroyed.
      expect(await counts(runId)).toEqual(PARSED_FULL);
      expect(await runStatus(runId)).toBe('cancelled');
      expect(await harness.service.listUnpushed({ userId })).not.toContainEqual(
        expect.objectContaining({ run: expect.objectContaining({ id: runId }) }),
      );

      // And the claim did not restart the history clock: what a crash leaves
      // behind ages on the run's original timestamps, so the sweep collects it
      // on the schedule it was always going to, rather than 90 days from now.
      expect(await runUpdatedAt(runId)).toEqual(agedAt);
      await retention.sweep();
      expect(await counts(runId)).toEqual(GONE);
    });

    it('refuses a run a Sync click reached first — the check and the delete share a row lock', async () => {
      const runId = await parsedNeverPushedRun(200);
      // A transaction holding the very row lock `startPush` takes inside its
      // append-and-reopen statement. The discard blocks on it, so the push below
      // lands BEFORE the discard reads its eligibility — which is the
      // interleaving the unlocked read could not see: it answered `pushable`
      // from one statement and deleted in another, with no lock spanning the
      // two.
      const runner = dataSource.createQueryRunner();

      await runner.connect();
      await runner.startTransaction();
      await runner.query(`SELECT id FROM ci_import.import_runs WHERE id = $1::uuid FOR UPDATE`, [runId]);

      // Resolved rather than rejected, so nothing is an unhandled rejection
      // while this test is still setting up.
      const discard = retention.discardRun({ userId }, runId).then(
        (value) => value as unknown,
        (err: unknown) => err,
      );

      // Long enough for the discard to be waiting on the lock rather than
      // racing us to it. The assertion holds under either interleaving: a
      // discard that has not reached the lock yet reads its eligibility after
      // this transaction commits, and sees the same push.
      await new Promise((resolve) => setTimeout(resolve, 250));

      await runner.query(
        `INSERT INTO ci_import.import_stages (run_id, seq, kind, status, weight)
         VALUES ($1::uuid,
                 (SELECT COALESCE(MAX(seq), -1) + 1 FROM ci_import.import_stages WHERE run_id = $1::uuid),
                 'push', 'queued', 1)`,
        [runId],
      );
      await runner.query(
        `UPDATE ci_import.import_runs SET status = 'queued', finished_at = NULL WHERE id = $1::uuid`,
        [runId],
      );
      await runner.commitTransaction();
      await runner.release();

      expect(await discard).toBeInstanceOf(ConflictException);
      // Not one row of what the push is about to write was taken, and the push
      // stage the winner appended is still there for the worker to run.
      expect(await counts(runId)).toEqual({ ...PARSED_FULL, stages: PARSED_FULL.stages + 1 });
    });

    it('404s a run id nothing ever minted', async () => {
      expect(await retention.discardRun({ userId }, randomUUID())).toBeNull();
    });
  });

  // ── the dials ─────────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('does nothing at all when disabled', async () => {
      const runId = await retiredRun(200);

      setRetention({ enabled: false });

      expect(await retention.sweep()).toEqual({
        payloadPurgedRuns: 0,
        stagedRowsDeleted: 0,
        runsDeleted: 0,
        sourceRowsDeleted: 0,
        uploadsRestaged: 0,
        skipped: {},
      });
      expect(await counts(runId)).toEqual(FULL);
    });

    it('honours a shorter staging window', async () => {
      const runId = await retiredRun(2);

      setRetention({ stagingDays: 30 });
      await retention.sweep();
      expect(await counts(runId)).toEqual(FULL);

      setRetention({ stagingDays: 1 });
      await retention.sweep();
      expect(await counts(runId)).toEqual(HISTORY_ONLY);
    });

    it('deletes a large payload across several batches', async () => {
      const runId = await retiredRun(30);

      // Two items, one entity: a batch size of 1 forces three delete rounds
      // per table plus the terminating short read, which is the loop the
      // 780k-row runs actually take.
      setRetention({ deleteBatchSize: 1 });

      const result = await retention.sweep();

      expect(await counts(runId)).toEqual(HISTORY_ONLY);
      expect(result.stagedRowsDeleted).toBeGreaterThanOrEqual(3);
    });

    it('bounds one sweep to maxRunsPerSweep', async () => {
      await retiredRun(30);
      await retiredRun(30);

      setRetention({ maxRunsPerSweep: 1 });

      expect((await retention.sweep()).payloadPurgedRuns).toBe(1);
      expect((await retention.sweep()).payloadPurgedRuns).toBe(1);
      expect((await retention.sweep()).payloadPurgedRuns).toBe(0);
    });

    it('does not let runs held by a scratch tree use up that budget', async () => {
      // Failed runs keep their trees and are the oldest, so they head every
      // candidate page. Counting them against the budget would stop the sweep
      // ever reaching the runs behind them.
      const held = [await failedUnpackRun(300), await failedUnpackRun(250)];
      const runId = await retiredRun(200);

      for (const heldId of held) {
        await mkdir(scratch.dirFor(userId, heldId), { recursive: true });
      }

      setRetention({ maxRunsPerSweep: 1 });

      const result = await retention.sweep();

      expect(result.runsDeleted).toBe(1);
      expect(result.skipped.scratch_tree_present).toBeGreaterThanOrEqual(2);
      expect(await counts(runId)).toEqual(GONE);

      for (const heldId of held) {
        expect(await runStatus(heldId)).toBe('failed');
        await rm(scratch.dirFor(userId, heldId), { recursive: true, force: true });
      }
    });
  });
});
