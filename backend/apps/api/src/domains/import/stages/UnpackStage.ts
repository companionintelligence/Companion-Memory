import path from 'node:path';

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { extractUploadedArchive, isExtractableArchive } from '../archive/extract';
import { freeBytesAt, stripSymlinks, unpackArchives, type RejectedArchive } from '../archive/unpack';
import { StagedSourceService } from '../services/StagedSourceService';
import { acquireLocalUnit } from '../sources/localAcquire';
import {
  DATABASE_FREE_FLOOR_BYTES,
  DatabaseVolumeFullError,
  readDatabaseSpace,
} from '../storage/databaseSpace';
import { withStageContext } from '../telemetry/stageError';
import { buildStageSummary, SUMMARY_KEY, type StageUnitInput } from '../telemetry/stageSummary';
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
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stagedSources: StagedSourceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(UnpackStage.name);
  }

  async run(context: StageRunContext): Promise<StageOutcome> {
    // Both volumes, before 40GB of anything moves. The archive preflight inside
    // `unpackArchives` covers scratch; this covers the one the push will write
    // into, which is a separate and much smaller disk on this appliance. Only
    // the already-empty case is refused here — how many database bytes an
    // archive becomes is not predictable from its size, so this is a floor
    // check, not an estimate, and the push re-checks as it goes.
    const databaseSpace = await readDatabaseSpace(this.dataSource);

    if (databaseSpace.freeBytes != null && databaseSpace.freeBytes < DATABASE_FREE_FLOOR_BYTES) {
      throw new DatabaseVolumeFullError(
        databaseSpace,
        'refusing to unpack an archive whose records could not be saved afterwards',
      );
    }

    const { localPath, filename } = await this.acquire(context);

    const rejected: RejectedArchive[] = [];
    let extractedFiles = 0;
    let method: string | null = null;
    let extractionLoss: string | null = null;

    if (isExtractableArchive(localPath)) {
      await context.progress({ processed: 0, total: 1, phase: 'extracting' });

      const result = await withStageContext(
        { stage: 'unpack', phase: 'extracting', file: filename ?? path.basename(localPath) },
        async () =>
          extractUploadedArchive(localPath, {
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
          }),
      );

      extractedFiles = result.files;
      method = result.method;

      if (result.partial) {
        // A real Takeout can carry entries no extractor will take — a name used
        // as both a file and a directory, an unsupported compression method.
        // The rest imported; the run says so rather than claiming a clean run.
        extractionLoss = result.partialReason ?? 'some entries could not be extracted';
        this.logger.warn('Archive extracted with losses', {
          runId: context.runId,
          filename,
          reason: extractionLoss,
        });
      }
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

    // Per-archive ticks, throttled to ~1/s: a 72-part Takeout answers "is it
    // doing anything?" 72 times instead of holding a blank bar for an hour.
    // The first tick (0 of N) and the last always land, whatever the clock —
    // the total appearing is the moment the bar becomes meaningful, and the
    // final tick squares the bar with reality before 'expanded' overwrites
    // the phase.
    let lastTickAt = 0;

    const nested = await withStageContext(
      { stage: 'unpack', phase: 'expanding', file: filename ?? undefined },
      async () =>
        unpackArchives(
          context.scratchDir,
          (message) => this.logger.debug(message, { runId: context.runId }),
          {
            deleteArchives: true,
            onRejected: (archive) => rejected.push(archive),
            onProgress: async ({ done, total, current }) => {
              const boundary = done === 0 || done === total;

              if (!boundary && Date.now() - lastTickAt < 1_000) {
                return;
              }

              lastTickAt = Date.now();
              await context.progress({
                processed: done,
                total,
                phase: current != null ? `extracting ${current}` : 'expanding',
              });
            },
          },
        ),
    );

    const nestedFiles = nested.reduce((sum, entry) => sum + entry.files, 0);

    // Last thing before the tree is handed to the parsers, and after every
    // extraction and flatten has finished creating entries. A symlink here is a
    // way to make the later stages read, move or delete a path the user never
    // offered — see stripSymlinks. Counted into the stage detail so a tree that
    // contained them is visible rather than silently altered.
    const symlinksRemoved = stripSymlinks(context.scratchDir, (message) =>
      this.logger.warn(message, { runId: context.runId }),
    );

    await context.progress({
      processed: Math.max(1, nested.length),
      total: Math.max(1, nested.length),
      phase: 'expanded',
    });

    return {
      processed: 1,
      total: 1,
      // A quarantined archive is the definition of half-worked: its siblings
      // imported, it did not, and the run must say so rather than reporting a
      // clean success over bytes nobody could read.
      partial: rejected.length > 0 || extractionLoss != null,
      detail: {
        filename,
        method,
        extractedFiles,
        nestedArchives: nested.length,
        nestedFiles,
        symlinksRemoved,
        extractionLoss,
        // Both volumes, named, so "did this import have room?" is answerable
        // from the run rather than from a shell on the appliance. The scratch
        // figure is what the archive preflight measured; the database figure is
        // what it never did.
        scratchFreeBytes: freeBytesAt(context.scratchDir),
        databaseFreeBytes: databaseSpace.freeBytes,
        databaseBytes: databaseSpace.databaseBytes,
        rejected: rejected.map((entry) => ({
          archive: path.basename(entry.archive),
          reason: entry.reason,
        })),
        // Additive. The keys above keep their exact shape; this is the same
        // facts as the reconciled per-archive account every other stage
        // reports, so a reader walking a run's four stages sees one shape
        // rather than four bespoke ones.
        //
        // The unit of this stage is an ARCHIVE, not a record: it consumes the
        // source plus every nested archive it finds, and produces the ones it
        // expanded. `extractionLoss` is a partial expansion of an archive that
        // DID open, so it is reported as a note on the top-level unit rather
        // than as a rejection — nobody knows how many entries were lost, only
        // that some were, and inventing a count would be worse than saying so.
        [SUMMARY_KEY]: buildStageSummary({
          stage: 'unpack',
          unitKind: 'archive',
          units: unpackUnits(filename, nested.length, rejected),
          zeroInputReason: 'no_input',
          samples: rejected.slice(0, 5).map((entry) => ({
            reason: 'archive_rejected' as const,
            slug: 'archive_rejected',
            detail: `${path.basename(entry.archive)}: ${entry.reason}`,
          })),
        }),
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
    const source = await this.stagedSources.findByRunId(context.userId, context.runId);

    if (source == null) {
      throw new NotFoundException(`Run ${context.runId} has no claimed source to unpack`);
    }

    await context.progress({ processed: 0, total: 1, phase: 'acquiring' });

    const { destPath, method } = await acquireLocalUnit({
      sourcePath: source.sourcePath,
      scratchDir: context.scratchDir,
      sizeBytes: source.sizeBytes,
      log: (message) => this.logger.debug(message, { runId: context.runId }),
      // A cancel releases an inbox claim and re-stages an upload. Either way
      // the source is no longer this run's to delete.
      stillClaimed: async () =>
        (await this.stagedSources.findByRunId(context.userId, context.runId))?.status === 'claimed',
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

/**
 * The unpack stage as archives consumed, expanded and rejected.
 *
 * One unit for the source the run was handed, one for the nested archives it
 * found inside it. Split, because they fail for different reasons and a person
 * debugging "why is this import empty?" needs to know whether the OUTER zip
 * opened at all — an appliance that rejected the upload itself and an appliance
 * that opened it and choked on one of 400 inner zips are very different
 * situations, and `rejected: [...]` alone did not distinguish them.
 *
 * A rejected archive counts as one drop, not as the records inside it: nobody
 * knows how many there were, and guessing would put a fabricated number into a
 * ledger whose whole value is that its numbers reconcile.
 */
function unpackUnits(
  filename: string | null,
  nestedExpanded: number,
  rejected: readonly RejectedArchive[],
): StageUnitInput[] {
  // Every rejection recorded by `unpackArchives` is nested by construction —
  // the top-level archive is expanded by `extractUploadedArchive`, which
  // throws rather than reporting a rejection.
  const nestedRejected = rejected.length;

  return [
    {
      unit: filename ?? '(source)',
      // The source either became a tree or the stage threw, so it is always one
      // consumed and one produced. `extractionLoss` — entries inside an archive
      // that DID open and could not be taken — is deliberately not a drop here:
      // the extractor reports that some were lost, never how many, and putting
      // a made-up number into a ledger whose value is that its numbers add up
      // would be worse than the prose already on `detail.extractionLoss`.
      produced: 1,
    },
    ...(nestedExpanded + nestedRejected > 0
      ? [
          {
            unit: '(nested archives)',
            produced: nestedExpanded,
            ...(nestedRejected > 0 ? { drops: { archive_rejected: nestedRejected } } : {}),
          },
        ]
      : []),
  ];
}
