import { PlaybackEnvironmentError } from '@ci/domains/files';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import { stageSchedule } from '../../schedule';
import { STAGE_VERSIONS } from '../../versions';
import { VIDEO_PLAYBACK_SOURCE, VideoPlaybackStage } from '../enrich/VideoPlaybackStage';

/**
 * A thin ledger adapter over VideoPlaybackService, tested as FilePreviewStage
 * is: which service outcomes become which ledger outcomes, that IO failures
 * are the only `failed`, and that the source predicate offers exactly the
 * rendition-less stored video originals.
 */
function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const videoPlaybackService = { generate: jest.fn() };
  const stage = new VideoPlaybackStage(videoPlaybackService as never, makeLogger() as never);

  return { stage, videoPlaybackService };
}

const ctx = { userId: 'user-1' } as never;

describe('VideoPlaybackStage — declaration', () => {
  it('is wired: registered id, declared version, enrich queue, file entity', () => {
    const { stage } = build();

    expect(stage.id).toBe(STAGE_IDS.ENRICH_VIDEO_PLAYBACK);
    expect(stage.version).toBe(STAGE_VERSIONS[STAGE_IDS.ENRICH_VIDEO_PLAYBACK]);
    expect(stage.queue).toBe(PIPELINE_QUEUES.ENRICH);
    expect(stage.entityTypes).toEqual(['file']);
  });

  it('declares shallow slices, since one id is a transcode of about the clip’s length', () => {
    const schedule = stageSchedule(STAGE_IDS.ENRICH_VIDEO_PLAYBACK);

    expect(schedule.sliceSize).toBeLessThanOrEqual(10);
    expect(schedule.window).toBe('enrichment');
  });

  it('offers only live, stored video ORIGINALs that have no PLAYBACK yet', () => {
    expect(VIDEO_PLAYBACK_SOURCE).toMatchObject({
      schema: 'ci',
      table: 'files',
      idColumn: 'id',
      userColumn: 'user_id',
    });
    expect(VIDEO_PLAYBACK_SOURCE.predicate).toContain("s.variant = 'ORIGINAL'");
    expect(VIDEO_PLAYBACK_SOURCE.predicate).toContain('s.deleted_at IS NULL');
    expect(VIDEO_PLAYBACK_SOURCE.predicate).toContain('s.key IS NOT NULL');
    expect(VIDEO_PLAYBACK_SOURCE.predicate).toContain("s.content_type LIKE 'video/%'");
    expect(VIDEO_PLAYBACK_SOURCE.predicate).not.toContain("'image/%'");
    expect(VIDEO_PLAYBACK_SOURCE.predicate).toContain("v.parent_id = s.id AND v.variant = 'PLAYBACK'");
  });
});

describe('VideoPlaybackStage.run', () => {
  it('maps generated → done, exists → done, skipped → skipped with the service’s reason and codec', async () => {
    const { stage, videoPlaybackService } = build();
    videoPlaybackService.generate
      .mockResolvedValueOnce({ outcome: 'generated', playbackId: 'p1', codec: 'hevc' })
      .mockResolvedValueOnce({ outcome: 'exists', playbackId: 'p2' })
      .mockResolvedValueOnce({ outcome: 'skipped', reason: 'not_needed', codec: 'h264' })
      .mockResolvedValueOnce({ outcome: 'skipped', reason: 'unprobeable' });

    const results = await stage.run(ctx, ['f1', 'f2', 'f3', 'f4']);

    expect(results.get('f1')).toEqual({ outcome: 'done', detail: { playbackId: 'p1', codec: 'hevc' } });
    expect(results.get('f2')).toEqual({
      outcome: 'done',
      reason: 'playback_exists',
      detail: { playbackId: 'p2' },
    });
    expect(results.get('f3')).toEqual({
      outcome: 'skipped',
      reason: 'not_needed',
      detail: { codec: 'h264' },
    });
    expect(results.get('f4')).toEqual({ outcome: 'skipped', reason: 'unprobeable' });
    expect(videoPlaybackService.generate).toHaveBeenCalledWith(ctx, { fileId: 'f1' });
  });

  it('records an IO throw as a retryable failure without failing the slice', async () => {
    const { stage, videoPlaybackService } = build();
    videoPlaybackService.generate
      .mockRejectedValueOnce(new Error('S3 object body was empty'))
      .mockResolvedValueOnce({ outcome: 'generated', playbackId: 'p2', codec: 'hevc' });

    const results = await stage.run(ctx, ['f1', 'f2']);

    expect(results.get('f1')).toEqual({
      outcome: 'failed',
      reason: 'object_storage_read_failed',
      detail: { message: 'S3 object body was empty' },
    });
    expect(results.get('f2')?.outcome).toBe('done');
  });

  // A missing zscale filter or a timed-out encode is the machine's fault: a
  // `skipped` row would never be re-offered after the machine was fixed.
  it('records an environment fault or a timeout as a failure named for it, not a skip', async () => {
    const { stage, videoPlaybackService } = build();
    videoPlaybackService.generate
      .mockRejectedValueOnce(
        new PlaybackEnvironmentError('environment', 'Error opening output files: Filter not found'),
      )
      .mockRejectedValueOnce(new PlaybackEnvironmentError('timeout', 'transcode exceeded 110 min'));

    const results = await stage.run(ctx, ['f1', 'f2']);

    expect(results.get('f1')).toEqual({
      outcome: 'failed',
      reason: 'transcode_environment',
      detail: { message: 'Error opening output files: Filter not found' },
    });
    expect(results.get('f2')).toEqual({
      outcome: 'failed',
      reason: 'transcode_timeout',
      detail: { message: 'transcode exceeded 110 min' },
    });
  });

  it('runs one transcode at a time', async () => {
    const { stage, videoPlaybackService } = build();
    let inFlight = 0;
    let peak = 0;
    videoPlaybackService.generate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;

      return { outcome: 'skipped', reason: 'not_needed', codec: 'h264' };
    });

    await stage.run(ctx, ['f1', 'f2', 'f3']);

    expect(peak).toBe(1);
  });
});
