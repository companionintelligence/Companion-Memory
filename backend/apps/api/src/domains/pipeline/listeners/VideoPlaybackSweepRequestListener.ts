import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import {
  VIDEO_PLAYBACK_SWEEP_QUEUE,
  VideoPlaybackSweepRequestEvent,
  type VideoPlaybackSweepRequestPayload,
} from '@ci/domains/files';

import { STAGE_IDS } from '../constants';
import { stageSchedule } from '../schedule';
import { PipelineDispatchService } from '../services/PipelineDispatchService';

/**
 * Turns an on-demand request (`POST /api/maintenance/video-playback-sweep`)
 * into an `enrich.video_playback` sweep for that user — the same handoff
 * shape as FilePreviewSweepRequestListener, for the same reason: the
 * maintenance API cannot reach PipelineDispatchService across the domain
 * boundary, so it sends an event the pipeline domain consumes.
 */
@Injectable()
export class VideoPlaybackSweepRequestListener {
  constructor(
    private readonly dispatchService: PipelineDispatchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(VideoPlaybackSweepRequestListener.name);
  }

  @OnEvent(VideoPlaybackSweepRequestEvent, {
    queue: VIDEO_PLAYBACK_SWEEP_QUEUE,
    queueOptions: { policy: 'short' },
  })
  async handleRequest(payload: VideoPlaybackSweepRequestPayload): Promise<void> {
    const { userId, requestedBy } = payload;

    if (userId == null || userId.length === 0) {
      this.logger.warn('Video playback sweep request carries no userId; ignoring', { requestedBy });

      return;
    }

    await this.dispatchService.startSweep({
      stage: STAGE_IDS.ENRICH_VIDEO_PLAYBACK,
      userId,
      // The same shallow slices the scheduled path uses — see the schedule.
      sliceSize: stageSchedule(STAGE_IDS.ENRICH_VIDEO_PLAYBACK).sliceSize,
    });

    this.logger.log('Video playback sweep started', {
      requestedBy,
      userId,
      stage: STAGE_IDS.ENRICH_VIDEO_PLAYBACK,
    });
  }
}
