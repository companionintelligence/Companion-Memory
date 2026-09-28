import { Injectable } from '@nestjs/common';

import { type UserServiceContext, toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import {
  FileService,
  PreviewGeneratedEvent,
  VideoFrameSampleService,
  type PreviewGeneratedPayload,
  type VideoFrame,
} from '@ci/domains/files';
import { ContentService } from '@ci/domains/memory';

import {
  IMAGE_DESCRIPTION_QUEUE,
  IMAGE_DESCRIPTION_QUEUE_OPTIONS,
  VISION_RENDITION_JPEG_QUALITY,
  VISION_RENDITION_MAX_DIMENSION,
} from '../constants';
import {
  IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
  VIDEO_DESCRIPTION_MAX_FRAMES,
  buildFramePrompt,
  buildMergePrompt,
  buildPrompt,
  parseDescription,
  type FileDescription,
  type FrameDescription,
} from '../descriptionPrompts';
import { CaptureContextService } from '../services/CaptureContextService';
import { ImageDescriptionPreferenceService } from '../services/ImageDescriptionPreferenceService';
import { OllamaService } from '../services/OllamaService';
import { VisionRenditionService } from '../services/VisionRenditionService';
import { isNonMultimodalModelError } from '../visionErrors';

export { IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS, buildPrompt } from '../descriptionPrompts';

const VIDEO_MIME_PREFIX = 'video/';

/** One model call's outcome: a label, nothing usable, or a model that takes no images at all. */
type LabelAttempt =
  | { outcome: 'labelled'; value: FileDescription }
  | { outcome: 'unusable' }
  | { outcome: 'unsupported' };

/**
 * Writes a title and description onto a file once its preview exists.
 *
 * A photo is one vision call over a rendition of the original. A video is
 * the same call over each of a few sampled frames, then one text-only call
 * that merges those frame descriptions into a label for the clip — because
 * no model served through Ollama takes a video, and a set of frames in one
 * message reads as a gallery on any model not trained on video (most of
 * them). Describing frames singly and merging in text asks nothing of the
 * model that the photo pass does not already ask, so whatever model the user
 * picked, the video path works exactly as well as their photo path does.
 */
@Injectable()
export class ImageDescriptionListener {
  constructor(
    private readonly fileService: FileService,
    private readonly contentService: ContentService,
    private readonly ollamaService: OllamaService,
    private readonly imageDescriptionPreference: ImageDescriptionPreferenceService,
    private readonly rendition: VisionRenditionService,
    private readonly captureContext: CaptureContextService,
    private readonly frameSampler: VideoFrameSampleService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImageDescriptionListener.name);
  }

  @OnEvent(PreviewGeneratedEvent, {
    queue: IMAGE_DESCRIPTION_QUEUE,
    queueOptions: IMAGE_DESCRIPTION_QUEUE_OPTIONS,
  })
  async handle(payload: PreviewGeneratedPayload) {
    // When the capture source opted out of server-side analysis (e.g. Companion Capture
    // with its own vision endpoint, which writes the title/description directly
    // via PATCH /files/:id), skip the Ollama pass entirely. Absent/false means
    // the server generates the description as usual.
    if (payload.skipDescription === true) {
      this.logger.log('Upload handled analysis itself, skipping image description', {
        previewId: payload.previewId,
      });

      return;
    }

    // Settings → Model "Describe images". Off by default so text-only models are
    // not flooded with multimodal 400s. Completing (not throwing) drains the queue.
    if (!(await this.imageDescriptionPreference.isEnabled(payload.userId))) {
      this.logger.log('Image description disabled — skipping', {
        previewId: payload.previewId,
        userId: payload.userId,
      });

      return;
    }

    const serviceContext = toServiceContext({
      userId: payload.userId,
    });

    const thumbnail = await this.fileService.findById(serviceContext, payload.previewId);

    if (thumbnail == null) {
      this.logger.warn('Thumbnail not found, skipping description generation', {
        thumbnailId: payload.previewId,
      });

      return;
    }

    if (thumbnail.parentId == null) {
      this.logger.warn('Thumbnail has no parent file, skipping description generation', {
        thumbnailId: payload.previewId,
      });

      return;
    }

    if (thumbnail.key == null) {
      this.logger.warn('Thumbnail has no storage key, cannot retrieve content', {
        thumbnailId: payload.previewId,
      });

      return;
    }

    const original = await this.fileService.findById(serviceContext, thumbnail.parentId);

    if (original?.contentType?.startsWith(VIDEO_MIME_PREFIX) && original.key != null) {
      await this.describeVideo(serviceContext, payload, {
        id: original.id,
        key: original.key,
        contentType: original.contentType,
        previewKey: thumbnail.key,
      });

      return;
    }

    // The preview event is the trigger, but the ORIGINAL is what the model is
    // shown — rendered down to a bounded size, with the thumbnail only as the
    // fallback for an original the decoder cannot read. See
    // VisionRenditionService for why neither extreme was right.
    const rendition = await this.rendition.render(
      serviceContext,
      original ?? { id: thumbnail.parentId, key: null, contentType: null },
      thumbnail.key,
    );

    if (rendition == null) {
      this.logger.warn('No image bytes available for description', {
        previewId: payload.previewId,
        parentFileId: thumbnail.parentId,
      });

      return;
    }

    // Only from THIS photo's own EXIF (via the bytes the rendition was made
    // from) — a preview-only fallback has no EXIF and gets no context. Never
    // inherited from a sibling or the import batch: the same hint on an
    // unrelated photo measurably leaks into its description.
    const captureContext =
      rendition.original == null
        ? null
        : await this.captureContext.build(serviceContext, rendition.original, thumbnail.parentId);

    const messages = [
      {
        role: 'user' as const,
        content: buildPrompt(captureContext?.text ?? null),
        images: [rendition.jpeg.toString('base64')],
      },
    ];

    const { model, numCtx } = await this.chooseModel(serviceContext, messages, payload.model);

    this.logger.log('Starting LLM chat for image description', {
      model,
      previewId: payload.previewId,
      parentFileId: thumbnail.parentId,
      renditionSource: rendition.source,
      renditionBytes: rendition.jpeg.length,
      captureContext: captureContext?.source ?? null,
    });

    const attempt = await this.label(serviceContext, messages, model, numCtx, {
      previewId: payload.previewId,
      parentFileId: thumbnail.parentId,
    });

    if (attempt.outcome !== 'labelled') {
      return;
    }

    await this.applyLabel(serviceContext, thumbnail.parentId, payload.previewId, attempt.value);
  }

  /**
   * The video path: frames singly, then one text merge.
   *
   * The sampled frames come from the original at the same size cap a photo
   * rendition gets. When the sampler yields nothing — a container ffmpeg can
   * seek but not decode — the PREVIEW that triggered this job is itself a
   * frame, so the clip still gets a one-frame description rather than none.
   */
  private async describeVideo(
    context: UserServiceContext,
    payload: PreviewGeneratedPayload,
    video: { id: string; key: string; contentType: string; previewKey: string },
  ): Promise<void> {
    const sample = await this.frameSampler.sample(context, video, {
      maxFrames: VIDEO_DESCRIPTION_MAX_FRAMES,
      maxDimension: VISION_RENDITION_MAX_DIMENSION,
      quality: VISION_RENDITION_JPEG_QUALITY,
    });

    let frames: VideoFrame[] = sample.frames;
    let frameSource: 'sampled' | 'preview' = 'sampled';

    if (frames.length === 0) {
      const preview = Buffer.from(await this.fileService.getFileContent(context, video.previewKey));

      frames = [{ atSeconds: 0, jpeg: preview }];
      frameSource = 'preview';
    }

    // The clip's own container tags only — the same rule as a photo's EXIF.
    const capture = sample.capture;
    const captureContext = await this.captureContext.buildFromCapture(
      context,
      {
        takenAt: capture.recordedAt,
        zoneKnown: capture.zoneKnown,
        takenOn: capture.recordedOn,
        latitude: capture.latitude,
        longitude: capture.longitude,
      },
      video.id,
      'video',
    );

    const frameMessages = frames.map((frame, index) => [
      {
        role: 'user' as const,
        content: buildFramePrompt(captureContext?.text ?? null, {
          index,
          count: frames.length,
          atSeconds: frame.atSeconds,
          durationSeconds: sample.durationSeconds,
        }),
        images: [frame.jpeg.toString('base64')],
      },
    ]);

    // One resolution for the whole clip, and the merge below runs on the same
    // model: swapping to a text model between frames would reload weights for
    // a 60-token answer.
    const { model, numCtx } = await this.chooseModel(context, frameMessages[0]!, payload.model);

    this.logger.log('Starting LLM chat for video description', {
      model,
      previewId: payload.previewId,
      parentFileId: video.id,
      durationSeconds: sample.durationSeconds,
      frames: frames.length,
      frameSource,
      captureContext: captureContext?.source ?? null,
    });

    const described: FrameDescription[] = [];

    for (const [index, messages] of frameMessages.entries()) {
      const attempt = await this.label(context, messages, model, numCtx, {
        previewId: payload.previewId,
        parentFileId: video.id,
        frame: index,
      });

      if (attempt.outcome === 'unsupported') {
        return;
      }

      if (attempt.outcome === 'labelled') {
        described.push({ atSeconds: frames[index]!.atSeconds, ...attempt.value });
      }
    }

    if (described.length === 0) {
      this.logger.warn('No video frame produced a description', {
        previewId: payload.previewId,
        parentFileId: video.id,
        frames: frames.length,
      });

      return;
    }

    const label =
      described.length === 1
        ? described[0]!
        : await this.merge(
            context,
            described,
            sample.durationSeconds,
            captureContext?.text ?? null,
            model,
            numCtx,
            video.id,
          );

    await this.applyLabel(context, video.id, payload.previewId, {
      title: label.title,
      description: label.description,
    });
  }

  /**
   * The text-only merge. A merge the model fumbles falls back to the middle
   * frame's label: a clip described by one of its own stills beats a clip
   * with no description, and the frame calls are already paid for.
   */
  private async merge(
    context: UserServiceContext,
    frames: FrameDescription[],
    durationSeconds: number | null,
    captureContext: string | null,
    model: string,
    numCtx: number | null,
    fileId: string,
  ): Promise<FileDescription> {
    const messages = [
      { role: 'user' as const, content: buildMergePrompt(frames, durationSeconds, captureContext) },
    ];
    const response = await this.ollamaService.chat(context, messages, {
      model,
      enableTools: false,
      enableThinking: false,
      format: 'json',
      maxOutputTokens: IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
      ...(numCtx != null && { numCtx }),
    });
    const parsed = parseDescription(response.message.content.trim());

    if (parsed.ok) {
      return parsed.value;
    }

    const middle = frames[Math.floor(frames.length / 2)]!;

    this.logger.warn('Video merge did not parse; using the middle frame label', {
      parentFileId: fileId,
      reason: parsed.reason,
      content: response.message.content,
    });

    return { title: middle.title, description: middle.description };
  }

  /**
   * Never hard-code a vision tag (e.g. llava:7b) — appliances serve whatever
   * Hub configured. resolveModel prefers a loaded vision model on native
   * Ollama; vLLM keeps the served chat id and `label` completes on 400.
   *
   * The context window is named explicitly rather than inherited from the
   * server default. A request that sends no `num_ctx` gets whatever
   * `OLLAMA_CONTEXT_LENGTH` (or Ollama's VRAM-based default) says, and on a
   * multi-slot server a default larger than the loaded per-slot window
   * reloads the model at that size times the slot count. The planner's answer
   * is the loaded window when the model is resident and a size that fits
   * otherwise; the ~1.5k-token prompt fits any rung. `null` (no planner)
   * keeps the old behaviour. Optional call: unit tests build this listener on
   * a partial facade.
   */
  private async chooseModel(
    context: UserServiceContext,
    messages: Array<{ role: 'user'; content: string; images?: string[] }>,
    requestedModel: string | undefined,
  ): Promise<{ model: string; numCtx: number | null }> {
    const { model } = await this.ollamaService.resolveModel(context, { messages, requestedModel });
    const numCtx = (await this.ollamaService.resolveChatContextTokens?.(model)) ?? null;

    return { model, numCtx };
  }

  /** One vision call and its parse. Only a model that takes no images at all ends the job. */
  private async label(
    context: UserServiceContext,
    messages: Array<{ role: 'user'; content: string; images?: string[] }>,
    model: string,
    numCtx: number | null,
    log: { previewId: string; parentFileId: string; frame?: number },
  ): Promise<LabelAttempt> {
    let response;
    try {
      response = await this.ollamaService.chat(context, messages, {
        model,
        enableTools: false,
        enableThinking: false,
        format: 'json',
        maxOutputTokens: IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
        ...(numCtx != null && { numCtx }),
      });
    } catch (error) {
      if (isNonMultimodalModelError(error)) {
        this.logger.warn('Model cannot accept images — skipping description gracefully', {
          model,
          ...log,
          error: error instanceof Error ? error.message : String(error),
        });

        return { outcome: 'unsupported' };
      }

      throw error;
    }

    const content = response.message.content.trim();

    if (!content) {
      this.logger.warn('LLM returned empty response', log);

      return { outcome: 'unusable' };
    }

    const parsed = parseDescription(content);

    if (!parsed.ok) {
      this.logger.warn('Failed to parse image metadata from LLM response', {
        ...log,
        reason: parsed.reason,
        content,
      });

      return { outcome: 'unusable' };
    }

    return { outcome: 'labelled', value: parsed.value };
  }

  private async applyLabel(
    context: UserServiceContext,
    parentFileId: string,
    previewId: string,
    metadata: FileDescription,
  ): Promise<void> {
    await this.fileService.update(context, parentFileId, {
      title: metadata.title,
      description: metadata.description,
    });

    this.logger.log('Image title and description applied to parent file', {
      previewId,
      parentFileId,
      title: metadata.title,
      description: metadata.description,
    });

    // The content row over this file is what the content library searches and
    // what a chat link opens; without this the label is only ever on the file
    // (see ContentService.applyFileLabel). The file write above already
    // landed, so a failure here is logged, not thrown: re-driving the whole
    // description over a content-side hiccup would pay for the model call again.
    try {
      const contentIds = await this.contentService.applyFileLabel(context, parentFileId, metadata);

      if (contentIds.length > 0) {
        this.logger.log('Image label applied to linked content', {
          parentFileId,
          contentIds,
        });
      }
    } catch (error) {
      this.logger.warn('Image label applied to file but not to its content row', {
        parentFileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
