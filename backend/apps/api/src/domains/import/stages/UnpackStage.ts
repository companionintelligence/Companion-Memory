import path from 'node:path';

import { Injectable, NotFoundException } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { extractUploadedArchive, isExtractableArchive } from '../archive/extract';
import { unpackArchives, type RejectedArchive } from '../archive/unpack';
import { StagedSourceService } from '../services/StagedSourceService';
import { acquireLocalUnit } from '../sources/localAcquire';
import type { ImportStageRunner, StageOutcome, StageRunContext } from '../types';

/**
 * Turn the staged bytes into a tree the parsers can walk.
 *
 * Three steps, in order, and the order matters:
 *
 *  1. MOVE the run's claimed source into its scratch directory — a staged
 *     upload's copy or an inbox unit, both already on this disk and both
 *     copies the importer owns, so acquisition is an atomic rename rather
 *     than a copy of a 50GB tree. The move IS the consume: the source leaves
 *     its staging area here, and the bytes are reclaimed with the run.
 *  2. Expand that archive through the GUARDED extractor (`archive/extract`),
 *     which enforces zip-slip and the size/entry caps. It runs first and alone
 *     because these are untrusted, user-supplied bytes.
 *  3. Recursively expand whatever the archive contained through
 *     `archive/unpack` — Takeout ships as a zip of zips — and flatten the
 *     `Takeout/` wrapper so per-category parsers see `Mail/`, `Google Photos/`
 *     at the level they recognize.
 *
 * A non-archive source is left exactly where it landed. Someone exporting a
 * single `.json` or a `chat.db` has given us the tree already; a directory
 * unit is simply a tree that needs no top-level extraction.
 */
@Injectable()
export class UnpackStage implements ImportStageRunner {
  readonly kind = 'unpack' as const;

  constructor(
    private readonly stagedSources: StagedSourceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(UnpackStage.name);
  }

  async run(context: StageRunContext): Promise<StageOutcome> {
    const { localPath, filename } = await this.acquire(context);

    const rejected: RejectedArchive[] = [];
    let extractedFiles = 0;
    let method: string | null = null;

    if (isExtractableArchive(localPath)) {
      await context.progress({ processed: 0, total: 1, phase: 'extracting' });

      const result = extractUploadedArchive(localPath, {
        // The extracted tree is what the parse stage reads, so keeping the zip
        // only doubles the run's disk footprint until cleanup — and a 350GB
        // Takeout has ENOSPC'd a 500GB-free disk exactly that way.
        deleteArchiveAfterExtract: true,
        // Passed explicitly rather than left to the extractor's own defaults,
        // which are a zip-bomb guard sized for an untrusted upload (100k
        // entries / 10GB) and reject the archives this stage exists to unpack.
        // Operators raise or lower them from one place; containment is asserted
        // per entry either way.
        maxEntries: config.import.maxArchiveEntries,
        maxTotalBytes: config.import.maxArchiveBytes,
      });

      extractedFiles = result.files;
      method = result.method;
    } else {
      this.logger.debug('Source is not an archive; leaving it in place', {
        runId: context.runId,
        filename,
      });

      extractedFiles = 1;
    }

    // Nested archives, and the Takeout wrapper. `deleteArchives` because every
    // zip under here is a copy the run owns and has already expanded — peak disk
    // becomes one archive plus the growing tree, rather than all of them at once.
    await context.progress({ processed: 0, total: 1, phase: 'expanding' });

    const nested = unpackArchives(
      context.scratchDir,
      (message) => this.logger.debug(message, { runId: context.runId }),
      {
        deleteArchives: true,
        onRejected: (archive) => rejected.push(archive),
      },
    );

    const nestedFiles = nested.reduce((sum, entry) => sum + entry.files, 0);

    await context.progress({ processed: 1, total: 1, phase: 'expanded' });

    return {
      processed: 1,
      total: 1,
      // A quarantined archive is the definition of half-worked: its siblings
      // imported, it did not, and the run must say so rather than reporting a
      // clean success over bytes nobody could read.
      partial: rejected.length > 0,
      detail: {
        filename,
        method,
        extractedFiles,
        nestedArchives: nested.length,
        nestedFiles,
        rejected: rejected.map((entry) => ({
          archive: path.basename(entry.archive),
          reason: entry.reason,
        })),
      },
    };
  }

  /**
   * Move the run's claimed source into scratch.
   *
   * The source is read by `run_id` from the registry — and only while its
   * claim is LIVE — rather than from the job payload: the claim is what binds
   * bytes to a run, and reading it back is what makes a retry pick up the
   * same source instead of whatever the payload said when it was enqueued. A
   * stage retried after its claim was released (or its upload re-staged)
   * finds nothing and fails honestly, instead of acquiring a path some newer
   * run now owns.
   *
   * The move is the consume — the source leaves its staging area here — and
   * `acquireLocalUnit`'s recovery protocol makes a retry after any crash
   * finish it rather than repeat it. Marking the row `moved` after the
   * filesystem work is covered by the same protocol: a crash between the two
   * re-enters through recovery.
   */
  private async acquire(context: StageRunContext): Promise<{ localPath: string; filename: string | null }> {
    const source = await this.stagedSources.findByRunId(context.runId);

    if (source == null) {
      throw new NotFoundException(`Run ${context.runId} has no claimed source to unpack`);
    }

    await context.progress({ processed: 0, total: 1, phase: 'acquiring' });

    const { destPath, method } = await acquireLocalUnit({
      sourcePath: source.sourcePath,
      scratchDir: context.scratchDir,
      sizeBytes: source.sizeBytes,
      log: (message) => this.logger.debug(message, { runId: context.runId }),
    });

    await this.stagedSources.markMoved(source.id);
    // The upload's <dropId>/ wrapper is empty now that its file has moved;
    // left alone it would sit until the orphan sweep. Inbox units have no
    // wrapper — the service no-ops for them.
    await this.stagedSources.reclaimMovedUploadDir(source);

    this.logger.log('Acquired staged source', { runId: context.runId, origin: source.origin, method });

    return {
      localPath: destPath,
      filename: source.originalFilename ?? path.basename(source.sourcePath),
    };
  }
}
