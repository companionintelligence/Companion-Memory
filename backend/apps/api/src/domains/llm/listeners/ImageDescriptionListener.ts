import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { FileService, PreviewGeneratedEvent, type PreviewGeneratedPayload } from '@ci/domains/files';

import { OllamaService } from '../services/OllamaService';

const DEFAULT_MODEL = 'llama3.2-vision:11b';

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

const ImageMetadataSchema = z.object({
  title: z.string(),
  description: z.string(),
});

@Injectable()
export class ImageDescriptionListener {
  constructor(
    private readonly fileService: FileService,
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImageDescriptionListener.name);
  }

  @OnEvent(PreviewGeneratedEvent, { queue: 'image-description' })
  async handle(payload: PreviewGeneratedPayload) {
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

    const fileContent = await this.fileService.getFileContent(serviceContext, thumbnail.key);
    const base64Image = Buffer.from(fileContent).toString('base64');
    const model = payload.model ?? DEFAULT_MODEL;

    this.logger.log('Starting LLM chat for image description', {
      model,
      previewId: payload.previewId,
      parentFileId: thumbnail.parentId,
    });

    const response = await this.ollamaService.chat(
      serviceContext,
      [
        {
          role: 'user',
          content: PROMPT,
          images: [base64Image],
        },
      ],
      {
        model,
        enableTools: false,
        format: 'json',
      },
    );

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
