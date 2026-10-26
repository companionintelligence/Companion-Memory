import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { PlaceService } from '@ci/domains/memory';

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

const DEFAULT_MAX_RESULTS = 25;

/**
 * Find photos and videos. A domain-scoped specialization of search: delegates to
 * {@link DatabaseSearchTool} with a fixed `file` entity scope, except when the
 * query names one of the user's places. Then the answer is the photos taken
 * there ({@link PlaceService.photosAtNamedPlace}): a photo's text never names
 * where it was taken, so a text search for the place found none of them, or
 * only the ones whose description happened to share a word with its name.
 */
@Injectable()
export class MediaFindPhotosTool extends BaseTool<MediaFindPhotosInput, SearchToolResult> {
  readonly schema: IntentDefinition = {
    name: 'media.findPhotos',
    local: {
      description:
        'Find your photos and videos by what they show, where or when. For "how many" set countOnly and use one word.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What, where or when.' },
          countOnly: { type: 'boolean', description: 'Return only the exact count, no items.' },
          maxResults: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: [],
      },
    },
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
    private readonly places: PlaceService,
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
    const atPlace = input.query?.trim()
      ? await this.places.photosAtNamedPlace(toServiceContext(context), input.query)
      : null;

    // A named place with no photos taken at it falls through to the text search.
    if (atPlace && atPlace.fileIds.length > 0) {
      return this.photosAtPlace(context, input, atPlace);
    }

    return this.search.run(context, {
      query: input.query,
      maxResults: input.maxResults,
      countOnly: input.countOnly,
      entityTypes: ['file'],
    });
  }

  private async photosAtPlace(
    context: ToolExecutionContext,
    input: MediaFindPhotosInput,
    atPlace: { places: Array<{ name: string }>; fileIds: string[] },
  ): Promise<SearchToolResult> {
    const where = atPlace.places.map((place) => place.name).join(' or ');
    const total = atPlace.fileIds.length;

    if (input.countOnly) {
      return {
        summary: `${total} photos and videos were taken at ${where} (exact count, by where each was taken; no items returned).`,
        totalMatches: total,
        truncated: false,
        limit: 0,
        mode: 'count',
        items: [],
      };
    }

    const limit = input.maxResults ?? DEFAULT_MAX_RESULTS;
    const items = await this.search.resolveFileHits(context, atPlace.fileIds.slice(0, limit));
    const summary =
      total <= items.length
        ? `${total} photos and videos taken at ${where}, found by where each was taken; all shown, newest first.`
        : `Showing the newest ${items.length} of ${total} photos and videos taken at ${where} (exact count). ` +
          'Report the total, not the number shown.';

    return { summary, totalMatches: total, truncated: total > items.length, limit, mode: 'place', items };
  }
}
