import { Controller, Get, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { TagService } from '@ci/domains/search-next';

import { GraphNodeEntity } from '../entities/GraphNodeEntity';
import { graphTypesToExclude } from '../graph.types';
import { EventService } from '../services/EventService';
import { GraphEventService } from '../services/GraphEventService';
import { GraphQueryService } from '../services/GraphQueryService';
import { GraphUtilityService } from '../services/GraphUtilityService';
import { UserContextService } from '../services/UserContextService';

/** Matches a canonical uuid; tag source ids that aren't uuids can never line up
 * with a graph node's uuid `entity_id`/`linked_id`, so we drop them before the
 * lookup to avoid a Postgres uuid cast error. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getNodeDetailsSchema = z.object({
  entityId: z.string(),
  maxDepth: z.coerce.number().int().min(1).max(5).optional(),
  maxNodes: z.coerce.number().int().min(1).max(250).optional(),
  maxEdges: z.coerce.number().int().min(1).max(500).optional(),
});

// CSV of explorer entity types the user currently has selected (e.g. "person,place").
// Absent => no entity-type filter (show all). Present (even empty "") => filter active; an
// empty selection excludes every mappable type. See graphTypesToExclude.
const explorerTypesParam = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value
          .split(',')
          .map((type) => type.trim())
          .filter(Boolean),
  );

// CSV of values for the LifeScope event-scoped dimensions (connectors / who /
// where / how). Absent => undefined (dimension off); present => the trimmed,
// non-empty values. Unlike `tags`, these are additive predicates, so an empty
// list means "no constraint", not "match nothing".
const csvListParam = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
  );

// `tags` is a comma-separated list of tag labels. Presence of the key (even
// when empty) marks the filter as active, mirroring the explorer's "filter
// active = present, even if empty" param contract.
//
// The remaining params mirror the explorer's Search dimensions so the graph
// reflects the same filtered subset as List/Gallery/Map: `connectors` (data
// source), `people` (who), `places` + `hasLocation` (where), `eventTypes`
// (how) and the `from`/`to` date range. They are event-scoped — resolved
// through the event timeline — exactly as the Search path treats them.
const graphDataSchema = z.object({
  includeTypes: explorerTypesParam,
  tags: z.string().optional(),
  connectors: csvListParam,
  people: csvListParam,
  places: csvListParam,
  eventTypes: csvListParam,
  hasLocation: z
    .string()
    .optional()
    .transform((value) => value === '1'),
  from: z.string().optional(),
  to: z.string().optional(),
});
// Graph search mirrors /data's restrictive filters so a search run with the
// explorer's tag/event-scoped dimensions active returns the same scoped subset
// the rest of the explorer honors. Shapes match graphDataSchema field-for-field.
const graphSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.coerce.number().int().positive().max(50).optional(),
  includeTypes: explorerTypesParam,
  tags: z.string().optional(),
  connectors: csvListParam,
  people: csvListParam,
  places: csvListParam,
  eventTypes: csvListParam,
  hasLocation: z
    .string()
    .optional()
    .transform((value) => value === '1'),
  from: z.string().optional(),
  to: z.string().optional(),
});

type GetNodeDetailsDto = z.infer<typeof getNodeDetailsSchema>;
type GraphDataDto = z.infer<typeof graphDataSchema>;
type GraphSearchDto = z.infer<typeof graphSearchSchema>;

/** Reports whether a restrictive id-filter (tags, or the event-scoped
 * dimensions) is engaged and which graph `entity_id`s match it. `active`
 * follows the param-presence contract; `entityIds` is empty when the filter is
 * active but matches nothing (e.g. `?tags=` or filters resolving to no events).
 * The client scopes the visible graph to the intersection of all active
 * matches. */
interface FilterMatch {
  active: boolean;
  entityIds: string[];
}

/** Upper bound on events scanned when resolving the event-scoped filters, so a
 * broad filter can't produce an unbounded match set / response. Matches the
 * id-resolution cap in {@link GraphUtilityService.getEntityIdsByLinkedOrEntityIds}. */
const EVENT_MATCH_EVENT_LIMIT = 2000;

/** Upper bound on nodes returned for the unfiltered graph overview. Filter
 * matches beyond this cap are recovered by an explicit by-id fetch (see
 * `getGraphData`); a full page signals the overview is truncated. */
const NODE_LIMIT = 200;

/** Intersect the active filter matches into a single allowed-id set, mirroring
 * the client's `combineMatches`: each active filter ANDs together, and an
 * inactive filter contributes no constraint. Returns `null` when no filter is
 * active, so callers leave the result unrestricted. */
function intersectActiveMatches(matches: FilterMatch[]): Set<string> | null {
  const activeSets = matches.filter((match) => match.active).map((match) => new Set(match.entityIds));

  if (activeSets.length === 0) {
    return null;
  }

  return activeSets.reduce((acc, set) => new Set([...acc].filter((id) => set.has(id))));
}

@Controller('graph')
@UseGuards(JwtOrApiKeyAuthGuard)
export class GraphController {
  constructor(
    private readonly graphEvents: GraphEventService,
    private readonly graphQuery: GraphQueryService,
    private readonly graphUtility: GraphUtilityService,
    private readonly userContext: UserContextService,
    private readonly tagService: TagService,
    private readonly eventService: EventService,
  ) {}

  private ensureUserId(ctx: RequestContext): string {
    if (!ctx.userId) {
      throw new Error('User ID is required');
    }

    return ctx.userId;
  }

  /**
   * Resolve the explorer's `tags` URL param into the set of graph `entity_id`s
   * carrying those tags, so the graph view can scope to the same entities as
   * the List/Gallery/Map explorers.
   *
   * Tags live on source records keyed by `(entity_type, entity_id)`, where the
   * id is the source record's id — which for Person/Concept/Place/File equals
   * the graph node's `entity_id`, and for Content/Event/Item/… equals the
   * node's `linked_id`. We resolve the tagged source ids, then translate them
   * to graph `entity_id`s; the client filters on the returned ids without
   * needing to know either id scheme.
   *
   * Contract: an absent param means the filter is inactive (whole graph). A
   * present param — even empty or resolving to nothing — means active with an
   * empty match set (graph shows nothing).
   */
  private async resolveTagMatch(
    ctx: RequestContext,
    ownerId: string,
    tagsParam: string | undefined,
  ): Promise<FilterMatch> {
    if (tagsParam === undefined) {
      return { active: false, entityIds: [] };
    }

    const labels = tagsParam
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label.length > 0);

    if (labels.length === 0) {
      return { active: true, entityIds: [] };
    }

    const tagged = await this.tagService.getEntitiesForTags(toServiceContext(ctx), labels);

    const sourceIds = Array.from(
      new Set(tagged.map((entity) => entity.id).filter((id) => UUID_PATTERN.test(id))),
    );

    if (sourceIds.length === 0) {
      return { active: true, entityIds: [] };
    }

    const entityIds = await this.graphQuery.getEntityIdsByTagSources(ownerId, sourceIds);

    return { active: true, entityIds };
  }

  /**
   * Resolve the explorer's event-scoped filters (connectors / who / where / how
   * / date range) into the set of graph `entity_id`s the graph view should
   * scope to — the same dimensions the Search path uses, so the graph reflects
   * the same filtered subset as List/Gallery/Map.
   *
   * These dimensions live on the event timeline, so we resolve the matching
   * events (bounded by {@link EVENT_MATCH_EVENT_LIMIT}), translate their source
   * ids to graph nodes, then expand one hop so the result keeps the
   * people/places/things the events connect to instead of collapsing to
   * isolated event dots. The expansion fetches only the relationships touching
   * the matched event nodes (`getRelationships` scoped to `eventNodeIds`),
   * rather than scanning the whole relationship table.
   *
   * Contract mirrors {@link resolveTagMatch}: inactive when no event dimension
   * is set; otherwise active with a (possibly empty) match set.
   */
  private async resolveEventMatch(
    ctx: RequestContext,
    ownerId: string,
    filters: {
      connectors?: string[];
      people?: string[];
      places?: string[];
      eventTypes?: string[];
      hasLocation?: boolean;
      from?: string;
      to?: string;
    },
  ): Promise<FilterMatch> {
    const connectors = filters.connectors?.length ? filters.connectors : undefined;
    const people = filters.people?.length ? filters.people : undefined;
    const places = filters.places?.length ? filters.places : undefined;
    const eventTypes = filters.eventTypes?.length ? filters.eventTypes : undefined;
    const hasLocation = filters.hasLocation === true ? true : undefined;

    const parsedStart = filters.from ? new Date(filters.from) : undefined;
    const parsedEnd = filters.to ? new Date(filters.to) : undefined;
    const startTime = parsedStart && !Number.isNaN(parsedStart.getTime()) ? parsedStart : undefined;
    const endTime = parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : undefined;

    const active =
      connectors != null ||
      people != null ||
      places != null ||
      eventTypes != null ||
      hasLocation != null ||
      startTime != null ||
      endTime != null;

    if (!active) {
      return { active: false, entityIds: [] };
    }

    const events = await this.eventService.getEntitiesForEvents(toServiceContext(ctx), {
      connectors,
      people,
      places,
      hasLocation,
      eventTypes,
      startTime,
      endTime,
      order: { startTime: 'DESC' },
      limit: EVENT_MATCH_EVENT_LIMIT,
    });

    const sourceIds = Array.from(
      new Set(events.map((event) => event.id).filter((id) => UUID_PATTERN.test(id))),
    );

    if (sourceIds.length === 0) {
      return { active: true, entityIds: [] };
    }

    const eventNodeIds = await this.graphQuery.getEntityIdsBySourceRecordIds(ownerId, sourceIds);

    if (eventNodeIds.length === 0) {
      return { active: true, entityIds: [] };
    }

    // Expand one hop so the filtered graph keeps the entities the matching
    // events connect to (people, places, things), not just the event nodes.
    // Fetch only the relationships touching the matched event nodes instead of
    // scanning the entire relationship table.
    const relationships = await this.graphQuery.getRelationships(ownerId, {
      entityIds: eventNodeIds,
      direction: 'both',
    });

    const seeds = new Set(eventNodeIds);
    const scoped = new Set(eventNodeIds);
    for (const rel of relationships) {
      if (seeds.has(rel.from_entity_id)) {
        scoped.add(rel.to_entity_id);
      }

      if (seeds.has(rel.to_entity_id)) {
        scoped.add(rel.from_entity_id);
      }
    }

    return { active: true, entityIds: Array.from(scoped) };
  }

  @Get('context')
  async getUserContext(@Context() ctx: RequestContext) {
    const ownerId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(ownerId);

    return {
      success: true,
      context,
    };
  }

  @Get('data')
  async getGraphData(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(graphDataSchema)) query: GraphDataDto,
  ) {
    const ownerId = this.ensureUserId(ctx);

    // Translate the explorer's entity-type selection into graph entity_type values to exclude.
    // Connective NER types (Concept/Goal/Tag) are never excluded so the graph stays connected.
    const excludeEntityTypes =
      query.includeTypes === undefined ? [] : graphTypesToExclude(query.includeTypes);
    const isFiltered = excludeEntityTypes.length > 0;

    const nodes = await this.graphQuery.getNodes(ownerId, { limit: NODE_LIMIT, excludeEntityTypes });
    const relationships = await this.graphQuery.getRelationships(ownerId, {});
    const tagMatch = await this.resolveTagMatch(ctx, ownerId, query.tags);
    const eventMatch = await this.resolveEventMatch(ctx, ownerId, {
      connectors: query.connectors,
      people: query.people,
      places: query.places,
      eventTypes: query.eventTypes,
      hasLocation: query.hasLocation,
      from: query.from,
      to: query.to,
    });

    // The base overview is capped at NODE_LIMIT with no inherent ordering, so a
    // restrictive filter match that sits beyond the cap would be absent from the
    // node payload even though the client knows (via tagMatch/eventMatch) it
    // should render. `truncated` reports the cap was hit so the client can
    // surface that the overview is partial.
    const truncated = nodes.length >= NODE_LIMIT;

    // The frontend seeds its subgraph from the owner's entity node. A type filter can exclude it
    // (e.g. the user is a Person and Person is deselected), which would collapse the graph to
    // empty — so always keep the anchor node regardless of the filter.
    const nodeMap = new Map(nodes.map((node) => [node.entity_id, node]));
    if (isFiltered) {
      const userEntity = await this.graphQuery.getUserEntity(ownerId);
      if (userEntity && !nodeMap.has(userEntity.entity_id)) {
        nodeMap.set(userEntity.entity_id, userEntity);
      }
    }

    // Union in any filter-matched nodes the capped overview missed. The
    // tag/event match sets are resolved independently of the NODE_LIMIT cap, so
    // fetch the matched nodes the cap dropped explicitly by id — otherwise the
    // client scopes to ids whose node objects never arrived and they vanish.
    const filterMatchedIds = intersectActiveMatches([tagMatch, eventMatch]);
    if (filterMatchedIds && filterMatchedIds.size > 0) {
      const missingIds = Array.from(filterMatchedIds).filter((id) => !nodeMap.has(id));
      if (missingIds.length > 0) {
        const excludedTypes = new Set(excludeEntityTypes);
        const matchedNodes = await this.graphQuery.getNodesByIds(ownerId, missingIds);
        for (const node of matchedNodes) {
          // Respect the explorer's entity-type filter: getNodes already excluded
          // these types, so don't reintroduce a type-excluded node via the by-id
          // fetch just because it matches the tag/event filter.
          if (excludedTypes.has(node.entity_type)) {
            continue;
          }

          nodeMap.set(node.entity_id, node);
        }
      }
    }

    const survivingNodes = Array.from(nodeMap.values());
    const survivingIds = new Set(survivingNodes.map((node) => node.entity_id));

    // Drop links dangling against excluded nodes when filtering; otherwise preserve prior behavior.
    const links = isFiltered
      ? relationships.filter(
          (rel) => survivingIds.has(rel.from_entity_id) && survivingIds.has(rel.to_entity_id),
        )
      : relationships;

    return {
      success: true,
      data: {
        nodes: survivingNodes.map((node) => ({
          id: node.entity_id,
          entity_id: node.entity_id,
          entity_type: node.entity_type,
          name: node.name,
          description: node.description,
          properties: node.properties || {},
        })),
        links: links.map((rel) => ({
          id: rel.relationship_id,
          relationship_id: rel.relationship_id,
          source: rel.from_entity_id,
          target: rel.to_entity_id,
          relationship_type: rel.relationship_type,
          strength: rel.strength || 0.5,
          properties: rel.properties || {},
        })),
      },
      tagMatch,
      eventMatch,
      truncated,
    };
  }

  @Get('search')
  async searchGraph(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(graphSearchSchema)) query: GraphSearchDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const limit = query.limit ?? 10;

    const trimmedQuery = query.query.trim();
    if (!trimmedQuery) {
      return { success: true, nodes: [] };
    }

    // Same entity-type filter as /data: skip nodes whose graph type maps to a deselected
    // explorer type, while keeping connective NER types.
    const excludeEntityTypes = new Set(
      query.includeTypes === undefined ? [] : graphTypesToExclude(query.includeTypes),
    );

    // Mirror the explorer's restrictive filters (tags + the event-scoped
    // dimensions) onto search, so a search run with filters active returns the
    // same scoped subset List/Gallery/Map and /api/graph/data honor. When any
    // filter is active we intersect the lexical candidates against the resolved
    // match set; an inactive filter adds no constraint. The event-scoped match
    // reuses resolveEventMatch's one-hop expansion over the full relationship
    // set, exactly as /data does.
    const tagMatch = await this.resolveTagMatch(ctx, ownerId, query.tags);

    const hasEventFilter =
      (query.connectors?.length ?? 0) > 0 ||
      (query.people?.length ?? 0) > 0 ||
      (query.places?.length ?? 0) > 0 ||
      (query.eventTypes?.length ?? 0) > 0 ||
      query.hasLocation === true ||
      query.from !== undefined ||
      query.to !== undefined;

    const eventMatch: FilterMatch = hasEventFilter
      ? await this.resolveEventMatch(ctx, ownerId, {
          connectors: query.connectors,
          people: query.people,
          places: query.places,
          eventTypes: query.eventTypes,
          hasLocation: query.hasLocation,
          from: query.from,
          to: query.to,
        })
      : { active: false, entityIds: [] };

    const filterAllowedIds = intersectActiveMatches([tagMatch, eventMatch]);

    // With a filter active the lexical candidates must survive the intersection,
    // so over-fetch (bounded) to preserve recall before slicing back to `limit`.
    const candidateLimit = filterAllowedIds ? Math.min(50, limit * 5) : limit;

    const textMatches = await this.graphQuery.searchNodesByText(ownerId, trimmedQuery, {
      limit: candidateLimit,
    });
    const prefixMatches = await this.graphQuery.searchNodesByPrefix(ownerId, trimmedQuery, {
      limit: candidateLimit,
    });

    const merged: Array<{ node: GraphNodeEntity; score: number | null }> = [];
    const seen = new Set<string>();

    for (const candidate of prefixMatches) {
      if (
        seen.has(candidate.entity_id) ||
        excludeEntityTypes.has(candidate.entity_type) ||
        (filterAllowedIds !== null && !filterAllowedIds.has(candidate.entity_id))
      ) {
        continue;
      }

      seen.add(candidate.entity_id);
      merged.push({ node: candidate, score: null });
      if (merged.length >= limit) {
        break;
      }
    }

    for (const candidate of textMatches) {
      if (
        seen.has(candidate.node.entity_id) ||
        excludeEntityTypes.has(candidate.node.entity_type) ||
        (filterAllowedIds !== null && !filterAllowedIds.has(candidate.node.entity_id))
      ) {
        continue;
      }

      seen.add(candidate.node.entity_id);
      merged.push({ node: candidate.node, score: candidate.score });
      if (merged.length >= limit) {
        break;
      }
    }

    const nodeIds = merged.map((match) => match.node.entity_id);

    if (nodeIds.length === 0) {
      return {
        success: true,
        nodes: [],
      };
    }

    const relationships = await this.graphQuery.getRelationships(ownerId, {
      entityIds: nodeIds,
      direction: 'both',
      includeInactive: false,
    });
    const filteredRelationships = relationships.filter(
      (rel) => nodeIds.includes(rel.from_entity_id) && nodeIds.includes(rel.to_entity_id),
    );

    const responseNodes = merged.map((match) => ({
      id: match.node.entity_id,
      entity_id: match.node.entity_id,
      entity_type: match.node.entity_type,
      name: match.node.name,
      description: match.node.description,
      properties: match.node.properties ?? {},
      score: match.score,
    }));

    return {
      success: true,
      nodes: responseNodes,
      links: filteredRelationships.map((rel) => ({
        id: rel.relationship_id,
        relationship_id: rel.relationship_id,
        source: rel.from_entity_id,
        target: rel.to_entity_id,
        relationship_type: rel.relationship_type,
        strength: rel.strength ?? 0.5,
        properties: rel.properties ?? {},
      })),
    };
  }

  /**
   * Resolve a graph node by its `entity_id`, falling back to a source-record
   * (`linked_id`) lookup. Lets callers pass either the graph entity id OR a
   * source id (e.g. an event/content/item id from the explorer drawer or a
   * detail page) — for separate-table records the source id is the node's
   * `linked_id`, not its `entity_id`. Non-uuid ids can't match a uuid column, so
   * we skip the DB to avoid a Postgres cast error (returns null → 404).
   */
  private async resolveNode(ownerId: string, id: string): Promise<GraphNodeEntity | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const direct = await this.graphQuery.getNode(ownerId, id);
    if (direct) {
      return direct;
    }

    const [linkedEntityId] = await this.graphQuery.getEntityIdsByTagSources(ownerId, [id]);

    return linkedEntityId ? this.graphQuery.getNode(ownerId, linkedEntityId) : null;
  }

  @Get('node')
  async getNodeDetails(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(getNodeDetailsSchema)) query: GetNodeDetailsDto,
  ) {
    const ownerId = this.ensureUserId(ctx);

    const node = await this.resolveNode(ownerId, query.entityId);
    if (!node) {
      throw new NotFoundException(`Node ${query.entityId} not found`);
    }

    const maxDepth = query.maxDepth ?? 1;
    const maxNodes = query.maxNodes ?? 100;
    const maxEdges = query.maxEdges ?? 250;

    const traversal = await this.graphQuery.traverseGraph(ownerId, [node.entity_id], {
      direction: 'both',
      maxDepth,
      maxNodes,
      maxEdges,
    });

    const traversalNodes = Array.from(traversal.nodes.values());
    const relationships = traversal.edges;

    const neighborIds = new Set<string>();
    for (const rel of relationships) {
      if (rel.from_entity_id !== node.entity_id && rel.to_entity_id !== node.entity_id) {
        continue;
      }

      const otherId = rel.from_entity_id === node.entity_id ? rel.to_entity_id : rel.from_entity_id;
      neighborIds.add(otherId);
    }

    const neighborMap = new Map(traversalNodes.map((n) => [n.entity_id, n]));

    const subgraph = {
      nodes: traversalNodes.map((graphNode) => ({
        id: graphNode.entity_id,
        entity_id: graphNode.entity_id,
        entity_type: graphNode.entity_type,
        name: graphNode.name,
        description: graphNode.description,
        properties: graphNode.properties ?? {},
      })),
      links: relationships.map((rel) => ({
        id: rel.relationship_id,
        relationship_id: rel.relationship_id,
        source: rel.from_entity_id,
        target: rel.to_entity_id,
        relationship_type: rel.relationship_type,
        strength: rel.strength ?? 0.5,
        properties: rel.properties ?? {},
      })),
    };

    return {
      success: true,
      node: {
        entityId: node.entity_id,
        entityType: node.entity_type,
        name: node.name,
        description: node.description,
        properties: node.properties ?? {},
        createdAt: node.created_at,
        updatedAt: node.updated_at,
      },
      relationships: relationships
        .map((rel) => {
          if (rel.from_entity_id !== node.entity_id && rel.to_entity_id !== node.entity_id) {
            return null;
          }

          const isOutbound = rel.from_entity_id === node.entity_id;
          const otherId = isOutbound ? rel.to_entity_id : rel.from_entity_id;
          const otherNode = neighborMap.get(otherId) ?? null;

          return {
            relationshipId: rel.relationship_id,
            relationshipType: rel.relationship_type,
            direction: isOutbound ? 'outbound' : 'inbound',
            strength: rel.strength,
            isBidirectional: rel.is_bidirectional,
            properties: rel.properties ?? {},
            otherEntity: otherNode
              ? {
                  entityId: otherNode.entity_id,
                  entityType: otherNode.entity_type,
                  name: otherNode.name,
                  description: otherNode.description,
                  properties: otherNode.properties ?? {},
                }
              : null,
          };
        })
        .filter((rel): rel is NonNullable<typeof rel> => rel !== null),
      subgraph,
    };
  }
}
