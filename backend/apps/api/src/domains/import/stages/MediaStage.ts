import { stat } from 'node:fs/promises';
import path from 'node:path';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { FileService } from '@ci/domains/files';

import { FILE_CLASSIFICATIONS } from '../push/canonical';
import type { ImportStageRunner, StageOutcome, StageRunContext } from '../types';

/** Staged media rows read per batch. Files are uploaded one at a time within it. */
const MEDIA_BATCH = 200;

/** One staged row that has bytes somewhere on disk. */
interface MediaRow {
  id: string;
  filename: string | null;
  mediaType: string | null;
  sizeBytes: string | number | null;
  localPath: string;
}

/**
 * Put an archive's bytes into the object store.
 *
 * The leg the consolidation left out. Upstream uploaded every photo, video,
 * voicemail and MMS part through `ci-server/media.ts` before sending the rows
 * that describe them; the port brought the read side across — `contentFileRef`
 * looks for `metadata.FileId`, `toContentInput` stamps it onto `external_id` —
 * but nothing ever wrote it. So a photo import produced `ci.content` rows
 * pointing at a file that did not exist, `EventMediaLoader` resolved them to
 * null (no gallery thumbnail, no downloadable attachment), and the actual bytes
 * were deleted with the run's scratch tree while the run reported success.
 *
 * ## Why a stage and not a step inside the push
 *
 * It is bounded by something else. Parse reads a tree, push writes Postgres,
 * and this talks to the object store — on a photo archive it is the longest leg
 * of the import by a wide margin, and the one most likely to die halfway. A
 * stage gets its own progress row, its own ETA and stage-granular retry, so an
 * object-store hiccup at photo 40,000 resumes here instead of re-running the
 * push. It runs BEFORE push because the push reads what it writes.
 *
 * ## Resumability
 *
 * Per row, like the push, and for the same reason — but keyed on the work's own
 * output rather than a separate ledger column: a row is done when its metadata
 * carries a `FileId`, so the selection query IS the resume point and shrinks as
 * the stage drains. A row whose bytes could not be read is stamped with
 * `FileMediaError` and skipped by the same query, so one unreadable file cannot
 * spin the stage forever.
 *
 * Dedup is the store's answer, not ours: `uploadWithDedupInfo` hashes the bytes
 * and returns the existing file when they are already held, which is what makes
 * a re-import of the same archive cost nothing and makes a `-edited` duplicate
 * share one object.
 */
@Injectable()
export class MediaStage implements ImportStageRunner {
  readonly kind = 'media' as const;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: FileService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MediaStage.name);
  }

  async run(context: StageRunContext): Promise<StageOutcome> {
    const remaining = await this.pendingCount(context.runId);
    const alreadyDone = await this.uploadedCount(context.runId);
    const total = remaining + alreadyDone;

    await context.progress({ processed: alreadyDone, total, phase: 'uploading' });

    if (remaining === 0) {
      // An archive with no media at all — a Takeout of nothing but JSON — is the
      // common case, not an edge one. Say so rather than reporting a bare zero.
      return {
        processed: alreadyDone,
        total,
        detail: { uploaded: 0, deduped: 0, failed: 0, carriedOver: alreadyDone },
      };
    }

    let uploaded = 0;
    let deduped = 0;
    let failed = 0;

    for (;;) {
      const batch = await this.nextBatch(context.runId);

      if (batch.length === 0) {
        break;
      }

      for (const row of batch) {
        const outcome = await this.uploadOne(context, row);

        if (outcome === 'uploaded') {
          uploaded += 1;
        } else if (outcome === 'deduped') {
          deduped += 1;
        } else {
          failed += 1;
        }

        await context.progress({
          processed: alreadyDone + uploaded + deduped + failed,
          total,
          phase: 'uploading',
        });
      }
    }

    this.logger.log('Uploaded staged media', { runId: context.runId, uploaded, deduped, failed });

    return {
      processed: alreadyDone + uploaded + deduped + failed,
      total,
      // A file the run was handed and could not store is a gap in the import,
      // and the run must say so rather than reporting a clean success over
      // bytes nobody will be able to open.
      partial: failed > 0,
      detail: { uploaded, deduped, failed, carriedOver: alreadyDone },
    };
  }

  /**
   * Store one row's bytes and point the row at the result.
   *
   * The path is re-validated against the run's own scratch directory before it
   * is opened. It arrives from a parser, which read it out of an archive the
   * user supplied, and this stage would otherwise be a primitive for reading
   * any file the API process can see. `realpath` resolution happens inside
   * `stat`/the read, so the containment check compares resolved segments rather
   * than string prefixes.
   */
  private async uploadOne(
    context: StageRunContext,
    row: MediaRow,
  ): Promise<'uploaded' | 'deduped' | 'failed'> {
    const resolved = path.resolve(row.localPath);
    const relative = path.relative(path.resolve(context.scratchDir), resolved);
    const contained = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

    if (!contained) {
      await this.markFailed(row.id, 'media path is outside the run scratch directory');

      return 'failed';
    }

    try {
      const stats = await stat(resolved);

      if (!stats.isFile()) {
        await this.markFailed(row.id, 'media path is not a file');

        return 'failed';
      }

      const { file, deduped } = await this.files.uploadWithDedupInfo(
        { userId: context.userId },
        {
          path: resolved,
          filename: row.filename ?? path.basename(resolved),
          contentType: row.mediaType ?? undefined,
          size: stats.size,
          // The description pass is an Ollama round trip per file. An archive
          // import is tens of thousands of files that the enrichment pipeline
          // will reach on its own schedule; doing it inline would make this
          // stage LLM-bound rather than store-bound.
          skipDescription: true,
        },
      );

      await this.markUploaded(row.id, file.id);

      return deduped ? 'deduped' : 'uploaded';
    } catch (err) {
      const reason = (err as Error).message;

      this.logger.warn('Could not store staged media; continuing with the rest', {
        runId: context.runId,
        stagedItemId: row.id,
        error: reason,
      });

      await this.markFailed(row.id, reason);

      return 'failed';
    }
  }

  /**
   * Rows with bytes on disk that this stage has not settled.
   *
   * The predicate mirrors `isMediaItem` — a binary MIME, or one of the
   * file-backed classifications — expressed in SQL so the selection stays a
   * single indexed scan rather than a fetch-and-filter over a whole run.
   */
  private mediaPredicate(): string {
    return `run_id = $1::uuid
        AND (media_type ~ '^(image|video|audio)/' OR classification = ANY($2::text[]))
        AND COALESCE(intermediate_location, original_location) IS NOT NULL
        AND metadata->>'FileId' IS NULL
        AND metadata->>'FileMediaError' IS NULL`;
  }

  private get classifications(): string[] {
    return [...FILE_CLASSIFICATIONS];
  }

  private async nextBatch(runId: string): Promise<MediaRow[]> {
    return this.dataSource.query<MediaRow[]>(
      `SELECT id, filename, media_type AS "mediaType", size_bytes AS "sizeBytes",
              COALESCE(intermediate_location, original_location) AS "localPath"
         FROM ci_import.staged_items
        WHERE ${this.mediaPredicate()}
        ORDER BY id
        LIMIT ${MEDIA_BATCH}`,
      [runId, this.classifications],
    );
  }

  private async pendingCount(runId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT count(*)::int AS count FROM ci_import.staged_items WHERE ${this.mediaPredicate()}`,
      [runId, this.classifications],
    )) as Array<{ count: number }>;

    return row?.count ?? 0;
  }

  /** Rows an earlier attempt already settled — the resume's starting count. */
  private async uploadedCount(runId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT count(*)::int AS count
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid
          AND (metadata->>'FileId' IS NOT NULL OR metadata->>'FileMediaError' IS NOT NULL)`,
      [runId],
    )) as Array<{ count: number }>;

    return row?.count ?? 0;
  }

  /**
   * Stamp the stored file's id onto the row.
   *
   * Written into `metadata` rather than a new column because that is the seam
   * the push already reads: `toCanonical` carries metadata through and
   * `contentFileRef` looks for exactly this key.
   */
  private async markUploaded(id: string, fileId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_import.staged_items
          SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{FileId}', to_jsonb($2::text), true)
        WHERE id = $1::uuid`,
      [id, fileId],
    );
  }

  private async markFailed(id: string, reason: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_import.staged_items
          SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{FileMediaError}', to_jsonb($2::text), true)
        WHERE id = $1::uuid`,
      [id, reason.slice(0, 500)],
    );
  }
}
