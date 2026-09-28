import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import { VIDEO_PLAYBACK_QUEUE, VideoPlaybackRequestEvent, type VideoPlaybackRequestPayload } from '../events';
import { PlaybackEnvironmentError, VideoPlaybackService } from '../services/VideoPlaybackService';

/**
 * Produce the browser-playable PLAYBACK rendition of a video soon after it
 * is uploaded — the upload-path trigger for {@link VideoPlaybackService},
 * exactly as FilePreviewGenerationListener is for previews. The request is
 * sent by FilePreviewService once the video's preview exists, so the drawer
 * has a poster to show while the transcode runs.
 *
 * `role: 'worker'`, one slot: a software transcode is a CPU-bound run of
 * about the clip's length and must not share the API process's event loop;
 * `policy: 'short'` with the per-file singleton key folds a repeat request
 * for the same file into the queued one. The other trigger is the
 * `enrich.video_playback` sweep, which backfills the library and is the net
 * under this listener.
 *
 * Outcomes are not inspected: the service logs every skip with the reason,
 * and completing the job on a skip is what stops an undecodable clip being
 * retried forever. IO failures throw and fail the job, which is the retry.
 *
 * A fault of the machine (a missing ffmpeg filter, a full disk, the encode
 * timeout — {@link PlaybackEnvironmentError}) also completes the job, but for
 * the opposite reason: it is retryable, just not on this queue's schedule.
 * pg-boss's retries come seconds apart, which fixes neither a missing filter
 * nor a full disk, and a timed-out encode retried here would burn its whole
 * budget again three times over. The clip still has no rendition, so the
 * sweep offers it again, and the ledger records it as a `failed` row with its
 * own backoff and attempt budget.
 */
@Injectable()
export class VideoPlaybackGenerationListener {
  constructor(
    private readonly videoPlaybackService: VideoPlaybackService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(VideoPlaybackGenerationListener.name);
  }

  @OnEvent(VideoPlaybackRequestEvent, {
    queue: VIDEO_PLAYBACK_QUEUE,
    queueOptions: { policy: 'short', role: 'worker', localConcurrency: 1 },
  })
  async generatePlayback(payload: VideoPlaybackRequestPayload): Promise<void> {
    const context = toServiceContext({ userId: payload.userId });

    try {
      await this.videoPlaybackService.generate(context, { fileId: payload.fileId });
    } catch (err: unknown) {
      if (!(err instanceof PlaybackEnvironmentError)) {
        throw err;
      }

      this.logger.warn('Playback rendition left to the sweep after an environment fault', {
        fileId: payload.fileId,
        reason: err.reason,
        error: err.message,
      });
    }
  }
}
