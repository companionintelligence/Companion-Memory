import { Injectable } from '@nestjs/common';
import plimit, { type LimitFunction } from 'p-limit';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The files domain's PUBLIC barrel, as MediaDimensionsStage does: the generator
// is exported there precisely so this stage and the upload listener share it.
import { FilePreviewService, FileVariant } from '@ci/domains/files';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { stageVersion } from '../../versions';

/**
 * Files rendered at once. Each is an object-storage read plus a sharp decode
 * (or an ffmpeg spool-and-extract for video); the same modest fan-out
 * MediaDimensionsStage uses, for the same reason — this bounds the CPU and
 * object storage one slice may hold, not the slice size.
 */
const MAX_RENDER_CONCURRENCY = 4;

const IMAGE_MIME_PREFIX = 'image/';
const VIDEO_MIME_PREFIX = 'video/';

/**
 * Which `ci.files` rows this stage applies to.
 *
 * Everything but the last clause is what a row IS — a live, locally-stored
 * original image or video — exactly MediaDimensionsStage's predicate. The
 * last clause, "has no PREVIEW yet", is deliberately part of applicability
 * rather than left to the ledger, and that is a departure from the one-rule
 * norm worth stating plainly: previews are ALSO written outside the ledger,
 * by the upload listener, for the overwhelming majority of files. Offering
 * every one of those to the sweep would spend an object-storage read per
 * file to rediscover a preview that exists. The consequence is the one
 * `versions.ts` notes — a version bump re-offers the preview-less corpus
 * only; re-rendering existing previews needs this clause dropped first.
 *
 * A file whose bytes cannot be decoded is recorded in the ledger as
 * `skipped: undecodable` and is NOT re-offered until the version is bumped,
 * which is the whole point of running under the ledger instead of a
 * `NOT EXISTS preview` loop that would re-fetch it every night forever.
 */
export const FILE_PREVIEW_SOURCE: StageSource = {
  schema: 'ci',
  table: 'files',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate:
    `s.variant = '${FileVariant.ORIGINAL}' ` +
    `AND s.deleted_at IS NULL ` +
    `AND s.key IS NOT NULL ` +
    `AND (s.content_type LIKE '${IMAGE_MIME_PREFIX}%' OR s.content_type LIKE '${VIDEO_MIME_PREFIX}%') ` +
    `AND NOT EXISTS (SELECT 1 FROM ci.files v WHERE v.parent_id = s.id AND v.variant = '${FileVariant.PREVIEW}')`,
};

@Injectable()
export class FilePreviewStage implements Stage {
  readonly id = STAGE_IDS.ENRICH_FILE_PREVIEW;

  readonly version = stageVersion(STAGE_IDS.ENRICH_FILE_PREVIEW);

  readonly queue = PIPELINE_QUEUES.ENRICH;

  readonly entityTypes = ['file'] as const;

  readonly source = FILE_PREVIEW_SOURCE;

  private readonly limiter: LimitFunction = plimit(MAX_RENDER_CONCURRENCY);

  constructor(
    private readonly filePreviewService: FilePreviewService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FilePreviewStage.name);
  }

  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    await Promise.all(
      ids.map((id) =>
        this.limiter(async () => {
          results.set(id, await this.renderOne(ctx, id));
        }),
      ),
    );

    return results;
  }

  private async renderOne(ctx: UserServiceContext, fileId: string): Promise<StageResult> {
    try {
      // `skipDescription` is not set: a preview rendered here reaches the
      // image-description pass exactly as an upload's would, since nothing
      // else will describe the file.
      const outcome = await this.filePreviewService.generate(ctx, { fileId });

      switch (outcome.outcome) {
        case 'generated':
          return { outcome: 'done', detail: { previewId: outcome.previewId } };
        case 'exists':
          return { outcome: 'done', reason: 'preview_exists', detail: { previewId: outcome.previewId } };
        case 'skipped':
          return { outcome: 'skipped', reason: outcome.reason };
      }
    } catch (err: unknown) {
      // The service throws only for IO — object storage reads, and a decode
      // on a short read — which is exactly the retryable class. Decode
      // failures on complete bytes come back as `skipped` above.
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn('Preview render failed', { fileId, error: message });

      return { outcome: 'failed', reason: 'object_storage_read_failed', detail: { message } };
    }
  }
}
