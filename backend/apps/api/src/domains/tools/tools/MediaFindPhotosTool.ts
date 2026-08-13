import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { DatabaseSearchTool, type SearchResult } from './DatabaseSearchTool';

const MediaFindPhotosInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type MediaFindPhotosInput = z.infer<typeof MediaFindPhotosInputSchema>;

/**
 * Find photos and videos. A domain-scoped specialization of search: delegates to
 * {@link DatabaseSearchTool} with a fixed `file` entity scope.
 */
@Injectable()
export class MediaFindPhotosTool extends BaseTool<MediaFindPhotosInput, SearchResult[]> {
  readonly schema: IntentDefinition = {
    name: 'media.findPhotos',
    domain: 'media',
    title: 'Find photos & videos',
    description: 'Find photos and videos by description, place, or time.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // Photos and videos are already ON the device — this is the intent most obviously local.
    localCapable: true,
    produces: ['file'],
    phrases: ['Show me photos of $subject', 'Find my videos from $place'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the photo/video is of, or where/when.' },
        maxResults: { type: 'integer', description: 'Max results (default 25).', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
  };

  constructor(
    private readonly search: DatabaseSearchTool,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(MediaFindPhotosTool.name);
  }

  protected validateInput(input: unknown): MediaFindPhotosInput {
    return MediaFindPhotosInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: MediaFindPhotosInput,
  ): Promise<SearchResult[]> {
    return this.search.run(context, {
      query: input.query,
      maxResults: input.maxResults,
      entityTypes: ['file'],
    });
  }
}
