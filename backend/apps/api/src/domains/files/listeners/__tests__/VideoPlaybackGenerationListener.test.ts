import { PlaybackEnvironmentError } from '../../services/VideoPlaybackService';
import { VideoPlaybackGenerationListener } from '../VideoPlaybackGenerationListener';

/**
 * The upload-path job's retry contract. IO failures throw, so pg-boss retries
 * the job. A fault of the machine — a missing ffmpeg filter, a full disk, the
 * encode timeout — completes it instead: pg-boss's retries come seconds apart
 * and would only re-run a timed-out encode, while the clip, still without a
 * rendition, is offered again by the sweep, whose ledger backs off and
 * quarantines visibly.
 */
function build() {
  const videoPlaybackService = { generate: jest.fn() };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
  const listener = new VideoPlaybackGenerationListener(videoPlaybackService as never, logger as never);

  return { listener, videoPlaybackService, logger };
}

const PAYLOAD = { userId: 'user-1', fileId: 'file-1' };

describe('VideoPlaybackGenerationListener', () => {
  it('generates the rendition as the file’s owner', async () => {
    const { listener, videoPlaybackService } = build();
    videoPlaybackService.generate.mockResolvedValue({ outcome: 'generated', playbackId: 'p', codec: 'hevc' });

    await listener.generatePlayback(PAYLOAD);

    expect(videoPlaybackService.generate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      {
        fileId: 'file-1',
      },
    );
  });

  it.each([
    new PlaybackEnvironmentError('environment', "No such filter: 'zscale'"),
    new PlaybackEnvironmentError('timeout', 'transcode exceeded 45 min'),
  ])('completes the job on a fault of the machine and leaves the clip to the sweep (%p)', async (err) => {
    const { listener, videoPlaybackService, logger } = build();
    videoPlaybackService.generate.mockRejectedValue(err);

    await expect(listener.generatePlayback(PAYLOAD)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('left to the sweep'),
      expect.objectContaining({ fileId: 'file-1', reason: err.reason }),
    );
  });

  it('throws anything else, so pg-boss retries the job', async () => {
    const { listener, videoPlaybackService } = build();
    videoPlaybackService.generate.mockRejectedValue(new Error('S3 object body was empty'));

    await expect(listener.generatePlayback(PAYLOAD)).rejects.toThrow('S3 object body was empty');
  });
});
