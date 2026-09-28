import { YieldGateRegistry } from '@ci/domains/events';

import { INTERACTIVE_CHAT_YIELD_GATE } from '../../constants';
import {
  IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
  ImageDescriptionListener,
  VIDEO_YIELD_MAX_WAIT_MS,
  VIDEO_YIELD_POLL_MS,
} from '../ImageDescriptionListener';

const USER = 'user-1';
const PREVIEW_ID = 'preview-1';
const ORIGINAL_ID = 'file-1';
const RENDERED = Buffer.from('rendered-jpeg');
const ORIGINAL = Buffer.from('original-bytes-with-exif');
const ANSWER = JSON.stringify({
  title: 'Gray Squirrel Foraging in Leaves',
  description: 'A squirrel on the ground.',
});

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

const PREVIEW_BYTES = Buffer.from('preview-frame-jpeg');
interface Capture {
  recordedAt: Date | null;
  zoneKnown: boolean;
  recordedOn: string | null;
  latitude: number | null;
  longitude: number | null;
}
const NO_CAPTURE: Capture = {
  recordedAt: null,
  zoneKnown: false,
  recordedOn: null,
  latitude: null,
  longitude: null,
};

function frameAnswer(n: number): string {
  return JSON.stringify({ title: `Frame ${n} title`, description: `Frame ${n} description.` });
}

function makeListener(
  opts: {
    enabled?: boolean;
    rendition?: unknown;
    /** One answer for every chat call, or one per call in order (the last repeats). */
    content?: string | string[];
    captureContext?: { text: string; source: string } | null;
    /** Make the ORIGINAL a video; the sampler then answers with this. */
    sample?: {
      durationSeconds: number | null;
      frames: Array<{ atSeconds: number; jpeg: Buffer }>;
      capture?: Capture;
    };
  } = {},
) {
  const { enabled = true, content = ANSWER, captureContext = null, sample } = opts;
  const answers = Array.isArray(content) ? content : [content];
  const rendition =
    'rendition' in opts ? opts.rendition : { jpeg: RENDERED, source: 'original', original: ORIGINAL };
  const original =
    sample == null
      ? { id: ORIGINAL_ID, parentId: null, key: 'orig-key', contentType: 'image/heic' }
      : { id: ORIGINAL_ID, parentId: null, key: 'orig-key', contentType: 'video/mp4' };
  const files = new Map<string, Record<string, unknown>>([
    [PREVIEW_ID, { id: PREVIEW_ID, parentId: ORIGINAL_ID, key: 'preview-key', contentType: 'image/jpeg' }],
    [ORIGINAL_ID, original],
  ]);
  const fileService = {
    findById: jest.fn(async (_ctx: unknown, id: string) => files.get(id) ?? null),
    getFileContent: jest.fn(async () => PREVIEW_BYTES),
    update: jest.fn(async () => ({})),
  };
  const contentService = {
    applyFileLabel: jest.fn(async () => ['content-1']),
  };
  let call = 0;
  const ollamaService = {
    resolveModel: jest.fn(async () => ({ model: 'gemma4:e4b', enableThinking: false, enableTools: false })),
    chat: jest.fn(
      async (
        _context: unknown,
        _messages: Array<{ role: string; content: string; images?: string[] }>,
        _options: unknown,
      ) => ({ message: { role: 'assistant', content: answers[Math.min(call++, answers.length - 1)] } }),
    ),
  };
  const preference = { isEnabled: jest.fn(async () => enabled) };
  const renditionService = { render: jest.fn(async () => rendition) };
  const captureContextService = {
    build: jest.fn(async () => captureContext),
    buildFromCapture: jest.fn(async () => captureContext),
  };
  const frameSampler = {
    sample: jest.fn(async () => ({ capture: NO_CAPTURE, ...sample })),
  };
  const logger = makeLogger();
  const listener = new ImageDescriptionListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contentService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ollamaService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    preference as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renditionService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    captureContextService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    frameSampler as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return {
    listener,
    fileService,
    contentService,
    ollamaService,
    renditionService,
    captureContextService,
    frameSampler,
    logger,
  };
}

describe('ImageDescriptionListener', () => {
  it('shows the model a rendition of the ORIGINAL, with the preview only as fallback', async () => {
    const { listener, ollamaService, renditionService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    // Rendered from the parent original; the preview's key is offered as the
    // fallback and nothing else.
    expect(renditionService.render).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      expect.objectContaining({ id: ORIGINAL_ID, key: 'orig-key' }),
      'preview-key',
    );

    const [, messages] = ollamaService.chat.mock.calls[0]!;

    expect(messages[0].images).toEqual([RENDERED.toString('base64')]);
  });

  it('writes the title and description onto the ORIGINAL file', async () => {
    const { listener, fileService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(fileService.update).toHaveBeenCalledWith(expect.anything(), ORIGINAL_ID, {
      title: 'Gray Squirrel Foraging in Leaves',
      description: 'A squirrel on the ground.',
    });
  });

  it('carries the label onto the content row that wraps the file', async () => {
    // The content library searches the content row, not the file, so a label
    // that stops at the file is invisible there (820 "squirrel" photos, zero
    // library hits, measured live).
    const { listener, contentService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(contentService.applyFileLabel).toHaveBeenCalledWith(expect.anything(), ORIGINAL_ID, {
      title: 'Gray Squirrel Foraging in Leaves',
      description: 'A squirrel on the ground.',
    });
  });

  it('keeps the file label when the content-side write fails', async () => {
    const { listener, fileService, contentService, logger } = makeListener();
    contentService.applyFileLabel.mockRejectedValueOnce(new Error('content down'));

    await expect(listener.handle({ userId: USER, previewId: PREVIEW_ID })).resolves.toBeUndefined();

    expect(fileService.update).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Image label applied to file but not to its content row',
      expect.objectContaining({ error: 'content down' }),
    );
  });

  // The two bounds that turned a 7s Gemma description into a 1.5s one: no
  // private chain of thought, and a ceiling on how much it may write back.
  it('calls the model with thinking off and a bounded output', async () => {
    const { listener, ollamaService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    const [, , options] = ollamaService.chat.mock.calls[0]!;

    expect(options).toMatchObject({
      enableThinking: false,
      enableTools: false,
      format: 'json',
      maxOutputTokens: IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
    });
  });

  it('completes without calling the model when nothing can be rendered', async () => {
    const { listener, ollamaService, fileService } = makeListener({ rendition: null });

    await expect(listener.handle({ userId: USER, previewId: PREVIEW_ID })).resolves.toBeUndefined();

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(fileService.update).not.toHaveBeenCalled();
  });

  it('completes without rendering or calling the model when description is off for the user', async () => {
    const { listener, ollamaService, renditionService } = makeListener({ enabled: false });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(renditionService.render).not.toHaveBeenCalled();
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  // Measured 2026-09-16: without a hint the model named five different cities
  // for one Palermo photo; with the appliance's own one-line context it named
  // the right one every time. The rule that stops guessing is always present.
  it('always tells the model not to name places or brands it cannot actually see', async () => {
    const { listener, ollamaService, captureContextService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    const [, messages] = ollamaService.chat.mock.calls[0]!;
    expect(messages[0].content).toContain('only when it is legible or unmistakable in the image');
    expect(messages[0].content).not.toContain('Context:');
    // The original's bytes went to the context builder, keyed by the ORIGINAL's id.
    expect(captureContextService.build).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      ORIGINAL,
      ORIGINAL_ID,
    );
  });

  it('adds the capture context to the prompt when the photo yields one', async () => {
    const { listener, ollamaService } = makeListener({
      captureContext: {
        text: 'Context: the photo was taken on 2024-05-05. The owner was in Palermo.',
        source: 'events',
      },
    });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    const [, messages] = ollamaService.chat.mock.calls[0]!;
    const content: string = messages[0].content;
    expect(content).toContain('Context: the photo was taken on 2024-05-05. The owner was in Palermo.');
    // Placed after the rules and before the schema, so it reads as input, not instruction.
    expect(content.indexOf('Context:')).toBeGreaterThan(content.indexOf('only when it is legible'));
    expect(content.indexOf('Context:')).toBeLessThan(content.indexOf('Return a JSON object'));
  });

  it('never builds context from a preview-only fallback, which has no EXIF', async () => {
    const { listener, ollamaService, captureContextService } = makeListener({
      rendition: { jpeg: RENDERED, source: 'preview' },
    });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(captureContextService.build).not.toHaveBeenCalled();
    expect(ollamaService.chat).toHaveBeenCalled();
  });

  it('honours a capture source that already described the image', async () => {
    const { listener, renditionService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID, skipDescription: true });

    expect(renditionService.render).not.toHaveBeenCalled();
  });
});

describe('ImageDescriptionListener — videos', () => {
  const FRAMES = [
    { atSeconds: 5, jpeg: Buffer.from('frame-5') },
    { atSeconds: 15, jpeg: Buffer.from('frame-15') },
    { atSeconds: 25, jpeg: Buffer.from('frame-25') },
  ];
  const MERGED = JSON.stringify({
    title: 'Squirrel Climbing a Boulder',
    description: 'A squirrel climbs a rock and pauses at the top.',
  });

  it('describes each sampled frame on its own, then merges them in a text-only call on the same model', async () => {
    const { listener, ollamaService, fileService, frameSampler, renditionService } = makeListener({
      sample: { durationSeconds: 30, frames: FRAMES },
      content: [frameAnswer(1), frameAnswer(2), frameAnswer(3), MERGED],
    });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    // Frames come from the sampler at the photo rendition's size cap; the
    // rendition service — which would download the whole video — is never asked.
    expect(frameSampler.sample).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      expect.objectContaining({ id: ORIGINAL_ID, key: 'orig-key', contentType: 'video/mp4' }),
      expect.objectContaining({ maxFrames: expect.any(Number), maxDimension: expect.any(Number) }),
    );
    expect(renditionService.render).not.toHaveBeenCalled();

    expect(ollamaService.chat).toHaveBeenCalledTimes(4);
    const calls = ollamaService.chat.mock.calls.map(([, messages]) => messages[0]);

    // One image per call, each frame alone, each told which frame it is.
    expect(calls[0].images).toEqual([Buffer.from('frame-5').toString('base64')]);
    expect(calls[0].content).toContain('frame 1 of 3');
    expect(calls[1].images).toEqual([Buffer.from('frame-15').toString('base64')]);
    expect(calls[2].content).toContain('frame 3 of 3');
    expect(calls[2].content).toContain('at 25s');

    // The merge carries no image and every frame's label, in order.
    expect(calls[3].images).toBeUndefined();
    expect(calls[3].content).toContain('at 5s: Frame 1 title — Frame 1 description.');
    expect(calls[3].content).toContain('at 25s: Frame 3 title — Frame 3 description.');

    // One model for the whole clip, asked for once.
    expect(ollamaService.resolveModel).toHaveBeenCalledTimes(1);
    for (const [, , options] of ollamaService.chat.mock.calls) {
      expect(options).toMatchObject({ model: 'gemma4:e4b', format: 'json', enableThinking: false });
    }

    expect(fileService.update).toHaveBeenCalledWith(expect.anything(), ORIGINAL_ID, {
      title: 'Squirrel Climbing a Boulder',
      description: 'A squirrel climbs a rock and pauses at the top.',
    });
  });

  it('skips the merge for a clip that yielded one frame', async () => {
    const { listener, ollamaService, fileService } = makeListener({
      sample: { durationSeconds: 1, frames: [FRAMES[0]!] },
      content: [frameAnswer(1)],
    });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(ollamaService.chat).toHaveBeenCalledTimes(1);
    expect(fileService.update).toHaveBeenCalledWith(expect.anything(), ORIGINAL_ID, {
      title: 'Frame 1 title',
      description: 'Frame 1 description.',
    });
  });

  it('describes the preview frame when the sampler could extract nothing', async () => {
    const { listener, ollamaService, fileService } = makeListener({
      sample: { durationSeconds: null, frames: [] },
      content: [frameAnswer(1)],
    });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(fileService.getFileContent).toHaveBeenCalledWith(expect.anything(), 'preview-key');
    const [, messages] = ollamaService.chat.mock.calls[0]!;
    expect(messages[0].images).toEqual([PREVIEW_BYTES.toString('base64')]);
    expect(fileService.update).toHaveBeenCalledTimes(1);
  });

  it('stops at the first frame, without writing, when the model takes no images', async () => {
    const { listener, ollamaService, fileService } = makeListener({
      sample: { durationSeconds: 30, frames: FRAMES },
    });
    ollamaService.chat.mockRejectedValue(new Error('gemma-text is not a multimodal model'));

    await expect(listener.handle({ userId: USER, previewId: PREVIEW_ID })).resolves.toBeUndefined();

    expect(ollamaService.chat).toHaveBeenCalledTimes(1);
    expect(fileService.update).not.toHaveBeenCalled();
  });

  it('falls back to the middle frame label when the merge does not parse', async () => {
    const { listener, fileService, logger } = makeListener({
      sample: { durationSeconds: 30, frames: FRAMES },
      content: [frameAnswer(1), frameAnswer(2), frameAnswer(3), 'I cannot combine these.'],
    });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(fileService.update).toHaveBeenCalledWith(expect.anything(), ORIGINAL_ID, {
      title: 'Frame 2 title',
      description: 'Frame 2 description.',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Video merge did not parse; using the middle frame label',
      expect.objectContaining({ parentFileId: ORIGINAL_ID }),
    );
  });

  it('drops a frame whose answer does not parse and merges the rest', async () => {
    const { listener, ollamaService } = makeListener({
      sample: { durationSeconds: 30, frames: FRAMES },
      content: [frameAnswer(1), 'garbage', frameAnswer(3), MERGED],
    });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    const [, merge] = ollamaService.chat.mock.calls[3]!;
    expect(merge[0].content).toContain('descriptions of 2 frames');
    expect(merge[0].content).not.toContain('at 15s');
  });

  it("builds the context line from the clip's own container tags, worded for a video", async () => {
    const recordedAt = new Date('2023-10-27T06:03:47.000Z');
    const { listener, captureContextService, ollamaService } = makeListener({
      sample: {
        durationSeconds: 30,
        frames: [FRAMES[0]!],
        capture: {
          recordedAt,
          zoneKnown: false,
          recordedOn: '2023-10-27',
          latitude: 33.6893,
          longitude: -117.8236,
        },
      },
      captureContext: { text: 'Context: the video was recorded on 2023-10-27.', source: 'date-only' },
    });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(captureContextService.buildFromCapture).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      {
        takenAt: recordedAt,
        zoneKnown: false,
        takenOn: '2023-10-27',
        latitude: 33.6893,
        longitude: -117.8236,
      },
      ORIGINAL_ID,
      'video',
    );
    expect(captureContextService.build).not.toHaveBeenCalled();
    const [, messages] = ollamaService.chat.mock.calls[0]!;
    expect(messages[0].content).toContain('Context: the video was recorded on 2023-10-27.');
  });

  // The queue's gate is asked only before a job is leased. A clip is up to
  // seven calls in one job, so it asks between them itself: sent back to back
  // they kept the runner busy until the chat turn waiting on a model swap
  // timed out.
  describe('standing aside for a chat turn', () => {
    let pending = false;

    beforeEach(() => {
      jest.useFakeTimers();
      pending = false;
      YieldGateRegistry.register(INTERACTIVE_CHAT_YIELD_GATE, () => pending);
    });

    afterEach(() => {
      YieldGateRegistry.clear();
      jest.useRealTimers();
    });

    it('waits between frames while a turn is pending, then carries on with the frames already described', async () => {
      const { listener, ollamaService, fileService } = makeListener({
        sample: { durationSeconds: 30, frames: FRAMES },
        content: [frameAnswer(2), frameAnswer(3), MERGED],
      });
      // The turn arrives while frame 1 is with the model.
      ollamaService.chat.mockImplementationOnce(async () => {
        pending = true;

        return { message: { role: 'assistant', content: frameAnswer(1) } };
      });

      const done = listener.handle({ userId: USER, previewId: PREVIEW_ID });

      await jest.advanceTimersByTimeAsync(30 * VIDEO_YIELD_POLL_MS);
      expect(ollamaService.chat).toHaveBeenCalledTimes(1);

      pending = false;
      await jest.advanceTimersByTimeAsync(VIDEO_YIELD_POLL_MS);
      await done;

      expect(ollamaService.chat).toHaveBeenCalledTimes(4);
      expect(fileService.update).toHaveBeenCalledWith(expect.anything(), ORIGINAL_ID, {
        title: 'Squirrel Climbing a Boulder',
        description: 'A squirrel climbs a rock and pauses at the top.',
      });
    });

    it('holds the merge too', async () => {
      const { listener, ollamaService } = makeListener({ sample: { durationSeconds: 30, frames: FRAMES } });
      ollamaService.chat.mockImplementationOnce(async () => ({
        message: { role: 'assistant', content: frameAnswer(1) },
      }));
      ollamaService.chat.mockImplementationOnce(async () => ({
        message: { role: 'assistant', content: frameAnswer(2) },
      }));
      ollamaService.chat.mockImplementationOnce(async () => {
        pending = true;

        return { message: { role: 'assistant', content: frameAnswer(3) } };
      });
      ollamaService.chat.mockImplementationOnce(async () => ({
        message: { role: 'assistant', content: MERGED },
      }));

      const done = listener.handle({ userId: USER, previewId: PREVIEW_ID });

      await jest.advanceTimersByTimeAsync(30 * VIDEO_YIELD_POLL_MS);
      expect(ollamaService.chat).toHaveBeenCalledTimes(3);

      pending = false;
      await jest.advanceTimersByTimeAsync(VIDEO_YIELD_POLL_MS);
      await done;

      expect(ollamaService.chat).toHaveBeenCalledTimes(4);
      expect(ollamaService.chat.mock.calls[3]![1][0]!.images).toBeUndefined();
    });

    it('does not hold a clip for longer than the cap, however long the conversation runs', async () => {
      pending = true;
      const { listener, ollamaService, fileService } = makeListener({
        sample: { durationSeconds: 30, frames: FRAMES },
        content: [frameAnswer(1), frameAnswer(2), frameAnswer(3), MERGED],
      });

      const done = listener.handle({ userId: USER, previewId: PREVIEW_ID });

      await jest.advanceTimersByTimeAsync(VIDEO_YIELD_MAX_WAIT_MS - VIDEO_YIELD_POLL_MS);
      expect(ollamaService.chat).not.toHaveBeenCalled();

      // Three frames and the merge, each after one full stand-aside.
      await jest.advanceTimersByTimeAsync(4 * VIDEO_YIELD_MAX_WAIT_MS);
      await done;

      expect(ollamaService.chat).toHaveBeenCalledTimes(4);
      expect(fileService.update).toHaveBeenCalled();
    });

    it('costs a photo nothing: its one call was already gated before the job was leased', async () => {
      pending = true;
      const { listener, ollamaService } = makeListener();

      await listener.handle({ userId: USER, previewId: PREVIEW_ID });

      expect(ollamaService.chat).toHaveBeenCalledTimes(1);
    });
  });
});
