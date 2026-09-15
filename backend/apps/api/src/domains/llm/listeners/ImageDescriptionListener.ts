import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { FileService, PreviewGeneratedEvent, type PreviewGeneratedPayload } from '@ci/domains/files';

import { IMAGE_DESCRIPTION_QUEUE, IMAGE_DESCRIPTION_QUEUE_OPTIONS } from '../constants';
import { ImageDescriptionPreferenceService } from '../services/ImageDescriptionPreferenceService';
import { OllamaService } from '../services/OllamaService';
import { VisionRenditionService } from '../services/VisionRenditionService';
import { isNonMultimodalModelError } from '../visionErrors';

const PROMPT = `
  Analyze this image and provide a title and description.
  You are a JSON generator. Output ONLY valid JSON.
  Do not include any conversational text, markdown formatting, or explanations.

  The title should be a short, specific label suitable for indexing and search (e.g. "Red KitchenAid Stand Mixer", "Family at Beach Sunset").
  The description should be a single concise paragraph describing the main subject, notable details, and context.

  Return a JSON object with the following schema:
  {
    "title": "Brief, indexable title for the image",
    "description": "A concise paragraph describing what is depicted"
  }
`;

/**
 * Output ceiling for one description. Measured titles+descriptions land at
 * 70-170 tokens; the cap exists so a model that ignores "concise" cannot run
 * a queue job to the backend's default length limit.
 */
export const IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS = 256;

const ImageMetadataSchema = z.object({
  title: z.string(),
  description: z.string(),
});

@Injectable()
export class ImageDescriptionListener {
  constructor(
    private readonly fileService: FileService,
    private readonly ollamaService: OllamaService,
    private readonly imageDescriptionPreference: ImageDescriptionPreferenceService,
    private readonly rendition: VisionRenditionService,
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

    // The preview event is the trigger, but the ORIGINAL is what the model is
    // shown — rendered down to a bounded size, with the thumbnail only as the
    // fallback for an original the decoder cannot read. See
    // VisionRenditionService for why neither extreme was right.
    const original = await this.fileService.findById(serviceContext, thumbnail.parentId);
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

    const messages = [
      {
        role: 'user' as const,
        content: PROMPT,
        images: [rendition.jpeg.toString('base64')],
      },
    ];

    // Never hard-code a vision tag (e.g. llava:7b) — appliances serve whatever
    // Hub configured. resolveModel prefers a loaded vision model on native
    // Ollama; vLLM keeps the served chat id and we complete below on 400.
    const { model } = await this.ollamaService.resolveModel(serviceContext, {
      messages,
      requestedModel: payload.model,
    });

    this.logger.log('Starting LLM chat for image description', {
      model,
      previewId: payload.previewId,
      parentFileId: thumbnail.parentId,
      renditionSource: rendition.source,
      renditionBytes: rendition.jpeg.length,
    });

    let response;
    try {
      response = await this.ollamaService.chat(serviceContext, messages, {
        model,
        enableTools: false,
        enableThinking: false,
        format: 'json',
        maxOutputTokens: IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
      });
    } catch (error) {
      if (isNonMultimodalModelError(error)) {
        this.logger.warn('Model cannot accept images — skipping description gracefully', {
          model,
          previewId: payload.previewId,
          parentFileId: thumbnail.parentId,
          error: error instanceof Error ? error.message : String(error),
        });

        return;
      }

      throw error;
    }

    const content = response.message.content.trim();

    if (!content) {
      this.logger.warn('LLM returned empty response', {
        previewId: payload.previewId,
        parentFileId: thumbnail.parentId,
      });

      return;
    }

    const metadata = this.parseResponse(content);

    if (metadata == null) {
      this.logger.warn('Failed to parse image metadata from LLM response', {
        previewId: payload.previewId,
        parentFileId: thumbnail.parentId,
        content,
      });

      return;
    }

    await this.fileService.update(serviceContext, thumbnail.parentId, {
      title: metadata.title,
      description: metadata.description,
    });

    this.logger.log('Image title and description applied to parent file', {
      previewId: payload.previewId,
      parentFileId: thumbnail.parentId,
      title: metadata.title,
      description: metadata.description,
    });
  }

  private parseResponse(content: string): z.infer<typeof ImageMetadataSchema> | null {
    let jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();

    const firstOpen = jsonStr.indexOf('{');
    const lastClose = jsonStr.lastIndexOf('}');

    if (firstOpen !== -1 && lastClose !== -1) {
      jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
    }

    try {
      const result = ImageMetadataSchema.safeParse(JSON.parse(jsonStr));

      if (!result.success) {
        this.logger.error(result.error, 'LLM response failed schema validation');

        return null;
      }

      return result.data;
    } catch (error) {
      this.logger.error(error as Error, 'Failed to parse JSON from LLM response');

      return null;
    }
  }
}
