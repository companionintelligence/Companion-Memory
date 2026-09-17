import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { booleanish } from './booleanish';
import { DatabaseSearchTool, requireQueryUnlessCounting, type SearchToolResult } from './DatabaseSearchTool';

const MediaFindPhotosInputSchema = z
  .object({
    query: z.string().max(500).optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
    countOnly: booleanish().optional(),
  })
  .superRefine(requireQueryUnlessCounting);

export type MediaFindPhotosInput = z.infer<typeof MediaFindPhotosInputSchema>;

/**
 * Find photos and videos. A domain-scoped specialization of search: delegates to
 * {@link DatabaseSearchTool} with a fixed `file` entity scope.
 */
@Injectable()
export class MediaFindPhotosTool extends BaseTool<MediaFindPhotosInput, SearchToolResult> {
  readonly schema: IntentDefinition = {
    name: 'media.findPhotos',
    domain: 'media',
    title: 'Find photos & videos',
    description:
      'Find photos and videos by description, place, or time. ' +
      'The result reports totalMatches and truncated alongside items: when truncated is true, ' +
      'say "at least N", never "N". To answer "how many photos of ..." set countOnly: true for ' +
      'an exact count with no items; omit query to count every photo and video. A multi-word ' +
      'query matches ANY of its words, so count on the single most specific word (e.g. "rabbit").',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // Photos and videos are already ON the device — this is the intent most obviously local.
    localCapable: true,
    produces: ['file'],
    phrases: ['Show me photos of $subject', 'Find my videos from $place'],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What the photo/video is of, or where/when. Required unless countOnly is true, when omitting it counts all.',
        },
        maxResults: { type: 'integer', description: 'Max results (default 25).', minimum: 1, maximum: 100 },
        countOnly: {
          type: 'boolean',
          description:
            'Return only the exact number of matching photos/videos, no items. Use for "how many". ' +
            'Omit query to count all of them.',
        },
      },
      required: [],
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
  ): Promise<SearchToolResult> {
    return this.search.run(context, {
      query: input.query,
      maxResults: input.maxResults,
      countOnly: input.countOnly,
      entityTypes: ['file'],
    });
  }
}
