import type { UserServiceContext } from '@ci/common/context';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

/**
 * "Events whose media match" — the second leg of a text search over events.
 *
 * A photo's words live on its file and content rows; the event only knows
 * when and where. A search scoped to events (the explorer's Events view, the
 * timeline heatmap) therefore never matched a photo by what is in it: measured
 * 2026-09-21, "squirrel" between 2023-10-21 and 2023-11-06 returned only the
 * messages containing the word, while hundreds of labelled photos sat behind
 * events in that range. This runs the same query over `content` and `file`,
 * maps the hits to their events through the content row's `event_id`, and
 * hands back event identifiers for the caller to merge after its direct hits.
 *
 * A plain function over two narrow service interfaces rather than a service of
 * its own: both callers (SearchResolver, ActivityTimelineService) already hold
 * SearchService and ContentService, and a constructor parameter would ripple
 * through every hand-built resolver in the specs for no gain.
 */

export interface MediaEventSearchDeps {
  searchService: {
    search(
      context: UserServiceContext,
      options: {
        query: string;
        maxResults?: number;
        includeTypes: IndexableEntity[];
        mode?: 'semantic';
      },
    ): Promise<EntityIdentifier<IndexableEntity>[]>;
  };
  contentService: {
    findEventIdsForMedia(
      context: UserServiceContext,
      hits: { contentIds: readonly string[]; fileIds: readonly string[] },
    ): Promise<string[]>;
  };
}

/** The entity types whose text can stand in for an event's. */
export const MEDIA_HIT_TYPES: IndexableEntity[] = ['content', 'file'];

/**
 * Whether a search's type scope reaches events at all. No scope means every
 * type; an include list must name `event`; an exclude list must not.
 */
export function searchReachesEvents(
  includeTypes?: readonly IndexableEntity[] | null,
  excludeTypes?: readonly IndexableEntity[] | null,
): boolean {
  if (includeTypes != null && includeTypes.length > 0) {
    return includeTypes.includes('event');
  }

  if (excludeTypes != null && excludeTypes.length > 0) {
    return !excludeTypes.includes('event');
  }

  return true;
}

/** Event identifiers for every event whose content or file matches `query`. */
export async function eventsForMatchingMedia(
  deps: MediaEventSearchDeps,
  context: UserServiceContext,
  options: { query: string; maxResults?: number; semantic?: boolean },
): Promise<EntityIdentifier<IndexableEntity>[]> {
  const hits = await deps.searchService.search(context, {
    query: options.query,
    maxResults: options.maxResults,
    includeTypes: MEDIA_HIT_TYPES,
    ...(options.semantic && { mode: 'semantic' as const }),
  });

  const contentIds = hits.filter((hit) => hit.type === 'content').map((hit) => hit.id);
  const fileIds = hits.filter((hit) => hit.type === 'file').map((hit) => hit.id);
  const eventIds = await deps.contentService.findEventIdsForMedia(context, { contentIds, fileIds });

  return eventIds.map((id) => ({ type: 'event' as const, id }));
}

/**
 * Direct hits first, in their ranked order, then the expanded events that are
 * not already among them. Ranking within the expansion is not meaningful (an
 * event inherits no score from its photo), so they trail.
 */
export function mergeIdentifiers<T extends { type: string; id: string }>(direct: T[], expanded: T[]): T[] {
  const seen = new Set(direct.map((identifier) => `${identifier.type}:${identifier.id}`));
  const merged = [...direct];

  for (const identifier of expanded) {
    const key = `${identifier.type}:${identifier.id}`;

    if (!seen.has(key)) {
      seen.add(key);
      merged.push(identifier);
    }
  }

  return merged;
}
