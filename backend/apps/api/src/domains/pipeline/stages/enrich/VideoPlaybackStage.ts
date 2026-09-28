import { Injectable } from '@nestjs/common';
import plimit, { type LimitFunction } from 'p-limit';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The files domain's PUBLIC barrel, as FilePreviewStage does: the generator is
// exported there precisely so this stage and the upload listener share it.
import { FileVariant, PlaybackEnvironmentError, VideoPlaybackService } from '@ci/domains/files';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { stageVersion } from '../../versions';

/**
 * One id at a time within a slice. Each is a software x264 encode that takes
 * about the clip's own length; the fan-out MediaDimensionsStage and
 * FilePreviewStage use (4) is for a decode-and-resize, not for this. The
 * enrich queue runs several slices at once, so the bound that actually holds
 * is VideoPlaybackService's process-wide encode slot; this keeps one slice
 * from queueing ten downloads behind it. Slices are ten ids
 * (`STAGE_SCHEDULES[...].sliceSize`) so a job is minutes, not hours.
 */
const MAX_TRANSCODE_CONCURRENCY = 1;

const VIDEO_MIME_PREFIX = 'video/';

/**
 * Which `ci.files` rows this stage applies to: live, locally-stored video
 * originals that carry no PLAYBACK child yet. The codec decision (does this
 * one NEED a rendition?) is deliberately not in SQL — the column that would
 * answer it does not exist, ffprobe does, and the service records
 * `skipped: not_needed` in the ledger for an H.264/VP9/AV1 original so it is
 * probed once and not again until the version is bumped. The "has none yet"
 * clause is applicability for the same reason FilePreviewStage's is: the
 * upload path writes renditions outside the ledger, and re-offering every
 * original with one would spend an object-storage read to rediscover it.
 */
export const VIDEO_PLAYBACK_SOURCE: StageSource = {
  schema: 'ci',
  table: 'files',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate:
    `s.variant = '${FileVariant.ORIGINAL}' ` +
    `AND s.deleted_at IS NULL ` +
    `AND s.key IS NOT NULL ` +
    `AND s.content_type LIKE '${VIDEO_MIME_PREFIX}%' ` +
    `AND NOT EXISTS (SELECT 1 FROM ci.files v WHERE v.parent_id = s.id AND v.variant = '${FileVariant.PLAYBACK}')`,
};

@Injectable()
export class VideoPlaybackStage implements Stage {
  readonly id = STAGE_IDS.ENRICH_VIDEO_PLAYBACK;

  readonly version = stageVersion(STAGE_IDS.ENRICH_VIDEO_PLAYBACK);

  readonly queue = PIPELINE_QUEUES.ENRICH;

  readonly entityTypes = ['file'] as const;

  readonly source = VIDEO_PLAYBACK_SOURCE;

  private readonly limiter: LimitFunction = plimit(MAX_TRANSCODE_CONCURRENCY);

  constructor(
    private readonly videoPlaybackService: VideoPlaybackService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(VideoPlaybackStage.name);
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
      const outcome = await this.videoPlaybackService.generate(ctx, { fileId });

      switch (outcome.outcome) {
        case 'generated':
          return { outcome: 'done', detail: { playbackId: outcome.playbackId, codec: outcome.codec } };
        case 'exists':
          return { outcome: 'done', reason: 'playback_exists', detail: { playbackId: outcome.playbackId } };
        case 'skipped':
          return {
            outcome: 'skipped',
            reason: outcome.reason,
            ...(outcome.codec != null ? { detail: { codec: outcome.codec } } : {}),
          };
      }
    } catch (err: unknown) {
      // The service throws only for what a retry can fix without the file
      // changing: IO (the object-storage read, the spool to disk) and a fault
      // of the machine — a missing ffmpeg filter or binary, a full disk, the
      // encode timeout. An input ffmpeg cannot handle comes back as
      // `skipped: transcode_failed` above. None of these is TRANSIENT in the
      // ledger's sense (a missing filter stays missing until someone fixes
      // it), so they spend the attempt budget and quarantine visibly.
      const message = err instanceof Error ? err.message : String(err);
      const reason =
        err instanceof PlaybackEnvironmentError ? `transcode_${err.reason}` : 'object_storage_read_failed';

      this.logger.warn('Playback rendition failed', { fileId, reason, error: message });

      return { outcome: 'failed', reason, detail: { message } };
    }
  }
}
