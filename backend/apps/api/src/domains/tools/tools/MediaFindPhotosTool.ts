import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { PlaceService, type PhotosAtNamedPlace } from '@ci/domains/memory';

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

/** Words a photo request carries beside the place, which say nothing about what the photo shows. */
const REQUEST_WORDS = new Set(
  (
    'a an the my me show find get see all any some of from at in on near around by taken ' +
    'photo photos picture pictures pic pics image images video videos shot shots'
  ).split(' '),
);

function requestWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The words of a place-naming query that are neither the place's name nor
 * request words: "dog" in "photos of my dog at Blue Bottle Coffee". The place
 * path answers with every photo taken there, so the model has to be told
 * these were not used, or it reports the place's photos as photos of a dog.
 */
function unusedSubjectWords(query: string, placeNames: string[]): string[] {
  const placeWords = new Set(placeNames.flatMap(requestWords));

  return [
    ...new Set(requestWords(query).filter((word) => !placeWords.has(word) && !REQUEST_WORDS.has(word))),
  ];
}

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
        'Find your photos and videos by what they show, where or when. For "how many" set countOnly and use one word, ' +
        "or a place's whole name.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What, where or when. A place by its whole name.' },
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
      'query matches ANY of its words, so count on the single most specific word (e.g. "rabbit"). ' +
      'A query that names one of the user\'s places in full (e.g. "Blue Bottle Coffee") returns the photos ' +
      "taken there instead, so pass a place's whole name, for a count too.",
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
    const atPlace = await this.findAtNamedPlace(context, input);

    // A named place with no photos taken at it falls through to the text search.
    if (atPlace && atPlace.total > 0) {
      return this.photosAtPlace(context, input, atPlace);
    }

    return this.search.run(context, {
      query: input.query,
      maxResults: input.maxResults,
      countOnly: input.countOnly,
      entityTypes: ['file'],
    });
  }

  /**
   * The photos taken at a place the query names, or null when there is no
   * query or the lookup failed. A failure is logged and the text search runs,
   * as it did before places were looked for at all.
   */
  private async findAtNamedPlace(
    context: ToolExecutionContext,
    input: MediaFindPhotosInput,
  ): Promise<PhotosAtNamedPlace | null> {
    if (!input.query?.trim()) {
      return null;
    }

    try {
      return await this.places.photosAtNamedPlace(
        toServiceContext(context),
        input.query,
        input.countOnly ? 0 : (input.maxResults ?? DEFAULT_MAX_RESULTS),
      );
    } catch (error) {
      this.logger.warn('Could not look for photos at a named place; searching their text instead', {
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
  }

  private async photosAtPlace(
    context: ToolExecutionContext,
    input: MediaFindPhotosInput,
    atPlace: PhotosAtNamedPlace,
  ): Promise<SearchToolResult> {
    const names = [...new Set(atPlace.places.map((place) => place.name))];
    const where = names.join(' or ');
    const { total } = atPlace;
    const unused = unusedSubjectWords(input.query ?? '', names);
    const notFiltered =
      unused.length > 0
        ? ` These are all of them, picked by place only and not filtered by "${unused.join(' ')}", which no photo's location can say.`
        : '';

    if (input.countOnly) {
      return {
        summary:
          `${total} photos and videos were taken at ${where}, counted by where each was taken ` +
          '(a photo or video with no location cannot be counted; no items returned).' +
          notFiltered,
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
      (total <= items.length
        ? `${total} photos and videos taken at ${where}, found by where each was taken; all shown, newest first.`
        : `Showing the newest ${items.length} of ${total} photos and videos taken at ${where} (exact count). ` +
          'Report the total, not the number shown.') + notFiltered;

    return { summary, totalMatches: total, truncated: total > items.length, limit, mode: 'place', items };
  }
}
