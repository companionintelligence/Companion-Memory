import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, type FacebookLike } from '@ci/domains/connections';
import {
  type GraphEntityInputDto,
  GraphIngestService,
  type GraphRelationshipInputDto,
} from '@ci/domains/graph';
import { ContentService, CalendarEventService, platformIdentity } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { FACEBOOK_SOURCE_SYSTEM, FACEBOOK_SOURCE_TYPE } from '../FacebookMediaService';

/** The graph-ingest sentinel for the signed-in user's own entity. */
const SELF_KEY = 'self';

export const FACEBOOK_LIKE_EVENT_TYPE = 'social.like';

/** Graph key for the Organization node that stands for a Facebook Page. */
export function pageEntityKey(pageId: string): string {
  return `${FACEBOOK_SOURCE_SYSTEM}:organization:${pageId}`;
}

/**
 * `/me/likes` → for every Page the user has liked: an `Organization` node for
 * the Page, a `self -[SUBSCRIBES_TO]-> Organization` edge, and an Event
 * ("Liked Facebook page <name>", type `social.like`) at the moment of the
 * like, with the Organization as its participant.
 *
 * A Facebook "like" here is a Page you follow — a business, a creator, a
 * brand — not a reaction to a post. That is a fact about the user's
 * relationship to an organisation with a date attached, which is an event
 * plus a graph edge, not a piece of content. (The earlier transform wrote
 * each Page as a `text/plain` `ci.content` row; those rows are removed here
 * as each like is re-transformed.)
 *
 * The Organization node goes through {@link GraphIngestService.ingest}, the
 * same idempotent path the archive importer and the graph enrichment use
 * for their Person/Organization/Concept nodes: keyed on
 * `facebook:organization:<page-id>`, so a re-sync updates the node rather
 * than minting another. The event is keyed on the provenance triple
 * `ETL / facebook / like:<page-id>`, which `CalendarEventService.create` already
 * treats as find-or-create.
 */
@Injectable()
export class FacebookLikesTransformService {
  constructor(
    private readonly eventService: CalendarEventService,
    private readonly contentService: ContentService,
    private readonly graphIngestService: GraphIngestService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookLikesTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;
    this.logger.log('Starting Facebook likes transformation', {
      userId,
      connectionId: connection.id,
    });
    try {
      const likes = this.extractLikes(data).filter((like) => !!like?.id);
      if (likes.length === 0) {
        this.logger.log('No Facebook likes found to transform', { userId, connectionId: connection.id });

        return;
      }

      const context = { userId };
      const organizationIds = await this.ingestPages(context, connection, likes);

      let events = 0;

      for (const like of likes) {
        try {
          const organizationId = organizationIds.get(like.id);
          const name = like.name?.trim() || `Page ${like.id}`;
          const likedAt = like.created_time ? new Date(like.created_time) : null;

          await this.eventService.create(context, {
            connection_id: connection.id,
            title: `Liked Facebook page ${name}`,
            description: like.category ? `${name} — ${like.category}` : name,
            event_type: FACEBOOK_LIKE_EVENT_TYPE,
            category: 'social',
            // Facebook stamps `created_time` with when the like happened. A
            // Page that reports none gets the ingest instant, said so.
            start_time: likedAt ?? new Date(),
            time_source: likedAt ? 'source' : 'ingest',
            participant_entity_ids: organizationId ? [organizationId] : undefined,
            source_type: FACEBOOK_SOURCE_TYPE,
            ...(() => {
              const identity = platformIdentity(FACEBOOK_SOURCE_SYSTEM, `like:${like.id}`);

              return { source_system: identity.system, source_id: identity.id };
            })(),
            metadata: {
              facebook_page_id: like.id,
              page_name: name,
              page_category: like.category,
              page_url: like.link,
              cover_url: like.cover?.source,
              connection_id: connection.id,
              organization_entity_id: organizationId,
            },
          });

          events += 1;

          await this.removeLegacyContent(userId, like.id);
        } catch (error) {
          this.logger.error('Error processing Facebook like', {
            pageId: like.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Facebook likes transformation completed', {
        userId,
        connectionId: connection.id,
        processedCount: likes.length,
        eventCount: events,
        organizationCount: organizationIds.size,
      });
    } catch (error) {
      this.logger.error('Error transforming Facebook likes', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * One Organization node per Page and a SUBSCRIBES_TO edge from the user,
   * in a single ingest call. Returns page id → entity id for the nodes that
   * upserted; a Page whose node failed is absent (logged) and its event is
   * still written, just without a participant.
   */
  private async ingestPages(
    context: { userId: string },
    connection: Connection,
    likes: FacebookLike[],
  ): Promise<Map<string, string>> {
    const entities: GraphEntityInputDto[] = [];
    const relationships: GraphRelationshipInputDto[] = [];

    for (const like of likes) {
      const key = pageEntityKey(like.id);

      entities.push({
        key,
        entityType: 'Organization',
        name: like.name?.trim() || `Page ${like.id}`,
        description: like.category ?? null,
        sourceSystem: FACEBOOK_SOURCE_SYSTEM,
        properties: {
          facebook_page_id: like.id,
          category: like.category,
          url: like.link,
          cover_url: like.cover?.source,
          connection_id: connection.id,
        },
      });

      relationships.push({
        fromKey: SELF_KEY,
        toKey: key,
        type: 'SUBSCRIBES_TO',
        properties: {
          source: FACEBOOK_SOURCE_SYSTEM,
          connection_id: connection.id,
          liked_at: like.created_time,
        },
      });
    }

    const result = await this.graphIngestService.ingest(context, { entities, relationships });

    if (result.errors.length > 0) {
      this.logger.warn('Some Facebook pages did not ingest into the graph', {
        connectionId: connection.id,
        errors: result.errors.slice(0, 5),
        errorCount: result.errors.length,
      });
    }

    const byKey = new Map(result.entities.map((mapping) => [mapping.key, mapping.entityId]));

    return new Map(
      likes
        .map((like) => [like.id, byKey.get(pageEntityKey(like.id))] as const)
        .filter((pair): pair is readonly [string, string] => pair[1] != null),
    );
  }

  /** Drop the `text/plain` content row the previous transform wrote for this Page. */
  private async removeLegacyContent(userId: string, pageId: string): Promise<void> {
    const rows = await this.contentService.search({ userId }, { external_id: pageId });

    for (const row of rows) {
      if ((row.sourceData as Record<string, unknown> | null)?.contentType === 'facebook_like') {
        await this.contentService.remove({ userId }, row.id);
        this.logger.log('Removed legacy Facebook like content row', { pageId, contentId: row.id });
      }
    }
  }

  private extractLikes(content: unknown): FacebookLike[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookLike[];
    }

    if ('likes' in contentObj && Array.isArray(contentObj.likes)) {
      return contentObj.likes as FacebookLike[];
    }

    return [];
  }
}
