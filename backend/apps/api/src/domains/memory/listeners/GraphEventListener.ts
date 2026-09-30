import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type EventPayloads, Events, EventService, OnEvent } from '@ci/domains/events';

import {
  ConceptCreatedEvent,
  ConceptUpdatedEvent,
  PersonCreatedEvent,
  PersonUpdatedEvent,
  PlaceCreatedEvent,
  PlaceUpdatedEvent,
} from '../events';
import { GraphUtilityService } from '../services/GraphUtilityService';

/**
 * The domains whose graph node lives in `ci.entities` AND is resolvable by their
 * own service, so re-emitting the per-type `*Created`/`*UpdatedEvent` is enough
 * to get the node indexed: the matching
 * `*SearchIndexListener` re-reads the row and writes BOTH the `ci_search.vectors`
 * tsvector (the search CANDIDATE source) and the `ci_search.embeddings` vector
 * (only a re-rank boost).
 *
 * Every other graph type is NOT indexed today. Its row has no detail half in
 * whatever table its own domain service reads (`ci.events`, `ci.objects`,
 * `ci.content`, `ci.files`, ...), so that per-type listener would find nothing
 * and log "not found, skipping indexing" if invoked — and
 * `GraphNodeSearchIndexListener` in search-ingress, which DOES see the payload
 * for these types, deliberately declines them too, for the identical reason: a
 * `ci_search.vectors` row for something `EntityResolutionService` can never
 * resolve is a paid-for row that can never be returned. See that listener's
 * `RESOLVABLE_FROM_ENTITIES_ALONE` for the full argument and what would need to
 * be true to change it.
 */
type IndexedDomain = 'person' | 'place' | 'concept';

/**
 * Graph vocabulary (`ci.entities.entity_type`, lower-cased) aliased onto the
 * domains above. Mirrors `GRAPH_TYPE_ALIASES` in `@ci/common/embeddings`,
 * restricted to the types this listener can re-emit for.
 */
const GRAPH_TYPE_TO_DOMAIN: Record<string, IndexedDomain> = {
  person: 'person',
  contact: 'person',
  place: 'place',
  location: 'place',
  concept: 'concept',
};

@Injectable()
export class GraphEventListener {
  constructor(
    private readonly graphUtility: GraphUtilityService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphEventListener.name);
  }

  @OnEvent(Events.GRAPH_NODE_UPSERTED)
  async handleNodeUpserted(payload: EventPayloads[Events.GRAPH_NODE_UPSERTED]) {
    // Fields go through as they arrived — an absent one stays `undefined`, which
    // `createOrUpdateNode` reads as "leave the stored value alone". A `?? null`
    // here would turn every omitted field into "clear it", which is how an
    // id-reuse `memory.remember` write used to null an imported row's linked key.
    const { node, created } = await this.graphUtility.createOrUpdateNode(payload.ownerId, {
      entityId: payload.node.entityId,
      entityType: payload.node.entityType,
      name: payload.node.name,
      description: payload.node.description,
      properties: payload.node.properties,
      searchContent: payload.node.searchContent,
      linkedTable: payload.node.linkedTable,
      linkedId: payload.node.linkedId,
      mergeProperties: payload.node.mergeProperties,
      removeProperties: payload.node.removeProperties,
    });

    // The write above is the ONLY thing that used to happen here: the
    // `created` flag `createOrUpdateNode` returns was discarded and no search
    // event was ever emitted, so everything an agent wrote through
    // `write_knowledge` (`GraphEventService.upsertNode`) landed in
    // `ci.entities` and was invisible to search and to /api/memory/recall.
    // Concept is not even in the backfill sweep's BACKFILLABLE_ENTITIES, so
    // nothing recovered it later either.
    //
    // No try/catch here: this handler is fire-and-forget from the agent's
    // point of view (WriteKnowledgeTool has already reported success by the
    // time this job runs), so a swallowed failure would be invisible
    // everywhere. Let it throw so the @OnEvent wrapper's ack.fail() engages
    // pg-boss's retryLimit/dead-letter path instead.
    await this.emitSearchIndexEvent(node.entity_type, node.entity_id, created);
  }

  @OnEvent(Events.GRAPH_RELATIONSHIP_UPSERTED)
  async handleRelationshipUpserted(payload: EventPayloads[Events.GRAPH_RELATIONSHIP_UPSERTED]) {
    // See handleNodeUpserted: no try/catch, so a write failure fails the ack
    // and engages retry/dead-letter instead of vanishing silently.
    await this.graphUtility.createOrUpdateRelationship(payload.ownerId, {
      relationshipId: payload.relationship.relationshipId,
      fromEntityId: payload.relationship.fromEntityId,
      toEntityId: payload.relationship.toEntityId,
      relationshipType: payload.relationship.relationshipType,
      properties: payload.relationship.properties,
      strength: payload.relationship.strength,
      isBidirectional: payload.relationship.isBidirectional,
      startDate: this.parseDate(payload.relationship.startDate),
      endDate: this.parseDate(payload.relationship.endDate),
      mergeProperties: payload.relationship.mergeProperties,
      removeProperties: payload.relationship.removeProperties,
    });
  }

  /**
   * Re-emit the per-type `*Created`/`*UpdatedEvent` for a graph node whose row
   * its own domain service can resolve, so the existing `*SearchIndexListener`
   * indexes it. Emitting AFTER the node write (rather than letting search-ingress
   * subscribe to `GRAPH_NODE_UPSERTED` directly) is deliberate: the two queues
   * are worked concurrently, so a listener racing the write would find no row.
   *
   * Updates re-emit too — an `entity.update` through `write_knowledge` can change
   * the name or description, and a stale tsvector is its own bug.
   *
   * Types with no entry fall through silently; `GraphNodeSearchIndexListener`
   * picks those up from the event payload instead.
   */
  private async emitSearchIndexEvent(
    entityType: string | null | undefined,
    entityId: string,
    created: boolean,
  ): Promise<void> {
    const domain = GRAPH_TYPE_TO_DOMAIN[(entityType ?? '').trim().toLowerCase()];

    if (!domain) {
      return;
    }

    switch (domain) {
      case 'person':
        await this.eventService.send(created ? PersonCreatedEvent : PersonUpdatedEvent, {
          personId: entityId,
        });

        return;
      case 'place':
        await this.eventService.send(created ? PlaceCreatedEvent : PlaceUpdatedEvent, {
          placeId: entityId,
        });

        return;
      case 'concept':
        await this.eventService.send(created ? ConceptCreatedEvent : ConceptUpdatedEvent, {
          conceptId: entityId,
        });

        return;
    }
  }

  private parseDate(value?: string | null): Date | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }

    return parsed;
  }
}
