import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { GraphIngestService } from '@ci/domains/graph';
import type { Content, ContentService, CreateContentDto } from '@ci/domains/memory';

/** Stamped on the `DOCUMENTS` edges this helper writes, so a sweep can tell them apart. */
export const SPOTIFY_ETL_EDGE_SOURCE = 'spotify_etl';

/**
 * Write the content row for a Spotify work (track, episode, show) and tie it to
 * the event that just happened to it (a play, a save).
 *
 * A work is stored ONCE per user, keyed by its Spotify id, but it can be played
 * or saved many times. `ci.content.event_id` holds a single event, so it goes to
 * the first one; every occurrence — including that first one — also gets a
 * `Content -DOCUMENTS-> Event` graph edge, which is how the second and later
 * plays reach their track. This mirrors what the file importer does in
 * `PushStage` (`withEvent` + `linkSharedContent`).
 *
 * Returns whether the content row was created by this call.
 */
export async function upsertContentForEvent({
  context,
  contentService,
  graph,
  logger,
  existing,
  input,
  eventId,
}: {
  context: UserServiceContext;
  contentService: ContentService;
  graph: GraphIngestService;
  logger: LoggerService;
  /** Rows already in `ci.content` for this work, from `contentService.search`. */
  existing: Content[];
  input: CreateContentDto;
  eventId: string | undefined;
}): Promise<{ contentId: string | undefined; created: boolean }> {
  let contentId = existing[0]?.id;
  let created = false;

  if (!contentId) {
    const [content] = await contentService.create(
      context,
      eventId ? { ...input, event: { id: eventId } } : input,
    );
    contentId = content?.id;
    created = true;
  }

  if (contentId && eventId) {
    await linkContentToEvent({ context, graph, logger, contentId, eventId });
  }

  return { contentId, created };
}

/**
 * `Content -DOCUMENTS-> Event` edge. Fail-soft: both rows are already in
 * `ci.*`, and a missed edge is what the graph edge sweep exists to catch.
 */
export async function linkContentToEvent({
  context,
  graph,
  logger,
  contentId,
  eventId,
}: {
  context: UserServiceContext;
  graph: GraphIngestService;
  logger: LoggerService;
  contentId: string;
  eventId: string;
}): Promise<void> {
  try {
    await graph.ingest(context, {
      entities: [],
      relationships: [
        {
          fromKey: `content:${contentId}`,
          toKey: `event:${eventId}`,
          fromEntityId: contentId,
          fromEntityType: 'Content',
          toEntityId: eventId,
          toEntityType: 'Event',
          type: 'DOCUMENTS',
          properties: { derived_from: SPOTIFY_ETL_EDGE_SOURCE },
        },
      ],
    });
  } catch (error) {
    logger.warn('Linking Spotify content to its event failed; the edge sweep will retry', {
      contentId,
      eventId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
