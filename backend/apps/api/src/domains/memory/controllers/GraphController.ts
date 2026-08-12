import { Body, Controller, Get, NotFoundException, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { TagService } from '@ci/domains/search-next';

import { GraphNodeEntity } from '../entities/GraphNodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';
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

/** Upper bound (and default) for the dots overview payload — 10x the classic
 * overview's {@link NODE_LIMIT}, cheap because each dot is four small fields. */
const DOTS_LIMIT = 2000;

/** Hard cap on ids accepted / edges returned by the section-edge fetch. */
const SECTION_EDGE_ID_LIMIT = 300;
const SECTION_EDGE_LIMIT = 400;

// The dots overview's params: the explorer's type selection, the How
// dimension's event types (narrows Event dots only — the full event-scoped
// resolution stays on /data), and (limit, offset) structured per-type so a
// future canvas layer can tile pages without a new endpoint shape.
const graphDotsSchema = z.object({
  includeTypes: explorerTypesParam,
  eventTypes: csvListParam,
  limit: z.coerce.number().int().min(1).max(DOTS_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// The section-edge fetch: edges among an explicit id set (the client's current
// viewport), both endpoints constrained server-side.
const graphEdgesSchema = z.object({
  ids: z.array(z.string().regex(UUID_PATTERN)).min(1).max(SECTION_EDGE_ID_LIMIT),
});

type GetNodeDetailsDto = z.infer<typeof getNodeDetailsSchema>;
type GraphDataDto = z.infer<typeof graphDataSchema>;
type GraphDotsDto = z.infer<typeof graphDotsSchema>;
type GraphEdgesDto = z.infer<typeof graphEdgesSchema>;
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

/** How many top tags the stats endpoint reports in its "by tag" breakdown. */
const STATS_TAG_LIMIT = 15;

/** Upper bound on events scanned when resolving the event-scoped filters, so a
 * broad filter can't produce an unbounded match set / response. Matches the
 * id-resolution cap in {@link GraphUtilityService.getEntityIdsByLinkedOrEntityIds}. */
const EVENT_MATCH_EVENT_LIMIT = 2000;

/** Upper bound on nodes returned for the unfiltered graph overview. Filter
 * matches beyond this cap are recovered by an explicit by-id fetch (see
 * `getGraphData`); a full page signals the overview is truncated. */
const NODE_LIMIT = 200;

/** How many of a person's most recent communications the focus subgraph pulls
 * in alongside the relationship traversal. Participant linking writes
 * `ci.communications.from_entity_id`/`to_entity_ids` — not `ci.relationships`
 * rows — so without this augmentation focusing a person never shows their
 * emails or messages, however many they exchanged. Capped because a busy
 * correspondent links thousands. */
const FOCUS_COMMUNICATION_LIMIT = 25;

/** The edge shape the focus response is built from: a real traversal edge or a
 * synthesized person↔communication tie. */
type FocusEdge = Pick<
  RelationshipEntity,
  | 'relationship_id'
  | 'from_entity_id'
  | 'to_entity_id'
  | 'relationship_type'
  | 'strength'
  | 'properties'
  | 'is_bidirectional'
>;

/** How many hops out from the owner's anchor entity the overview traversal
 * reaches when seeding the node budget. Matches the client's `maxDepth: 3`
 * subgraph, so everything the client would BFS to is in the payload. */
const ANCHOR_NEIGHBORHOOD_DEPTH = 3;

/** Edge budget for the anchor-neighborhood traversal (the traversal's hard
 * cap). Edges aren't returned from it — the overview ships all relationships
 * separately — this only bounds how far the traversal can expand. */
const ANCHOR_NEIGHBORHOOD_EDGE_LIMIT = 500;

/**
 * How much of {@link NODE_LIMIT} the anchor neighborhood may consume before
 * the per-type fill takes over.
 *
 * The neighborhood BFS is first-come-first-served over whatever edges the
 * anchor happens to have, and on a real account those are overwhelmingly one
 * type — measured on the appliance this was built against, the anchor's
 * person↔person email edges filled all 200 slots and the overview rendered
 * ZERO of the account's 183k Communications, 108k Events, 37k Content rows or
 * 102 Locations. Half the budget keeps the anchor's social core; the other
 * half is reserved for showing every data type the account actually has.
 */
const ANCHOR_NEIGHBORHOOD_NODE_BUDGET = Math.floor(NODE_LIMIT / 2);

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

  /**
   * Memory-wide totals for the stats page: timeline event count + date span,
   * entity/relationship totals, entities per data source (each bucket tagged
   * with the class of provenance that produced it — see
   * {@link GraphUtilityService.getEntityCountsBySource}), and the user's
   * {@link STATS_TAG_LIMIT} most-used tags.
   */
  @Get('stats')
  async getMemoryStats(@Context() ctx: RequestContext) {
    const ownerId = this.ensureUserId(ctx);

    const [relationshipStats, bySource, byTag, timeline] = await Promise.all([
      this.graphUtility.getRelationshipStats(ownerId),
      this.graphUtility.getEntityCountsBySource(ownerId),
      this.tagService.getTagUsageCounts(toServiceContext(ctx), STATS_TAG_LIMIT),
      this.eventService.getTimelineStats(toServiceContext(ctx)),
    ]);

    const totalEntities = relationshipStats.entitiesByType.reduce((sum, entry) => sum + entry.count, 0);

    return {
      success: true,
      data: {
        totals: {
          events: timeline.totalEvents,
          entities: totalEntities,
          relationships: relationshipStats.totalRelationships,
        },
        dateRange: {
          earliest: timeline.earliest,
          latest: timeline.latest,
        },
        bySource,
        byTag,
      },
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

    const nodeMap = await this.assembleOverviewNodes(ownerId, excludeEntityTypes);
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

    // The base overview is capped at NODE_LIMIT, so a restrictive filter match
    // outside the anchor neighborhood / recency window would be absent from the
    // node payload even though the client knows (via tagMatch/eventMatch) it
    // should render. `truncated` reports the cap was hit so the client can
    // surface that the overview is partial.
    const truncated = nodeMap.size >= NODE_LIMIT;

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

    // Fetch only the relationships touching the assembled node payload, and keep
    // only those whose BOTH endpoints are in it. The previous unscoped fetch
    // returned the account's entire relationship table — with real imported
    // data that was easily 100k+ rows, most of them dangling against entities
    // the capped node payload doesn't contain. The client can never render a
    // dangling link (both endpoints must be loaded nodes), but it still paid to
    // index them all, which froze the browser's main thread for minutes and
    // made the graph view impossible to navigate away from (#1598).
    const relationships =
      survivingIds.size > 0
        ? await this.graphQuery.getRelationships(ownerId, {
            entityIds: Array.from(survivingIds),
            direction: 'both',
          })
        : [];
    const links = relationships.filter(
      (rel) => survivingIds.has(rel.from_entity_id) && survivingIds.has(rel.to_entity_id),
    );

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

  /**
   * Assemble the capped node payload for the graph overview: the anchor's
   * neighborhood first, then EVERY entity type the account has.
   *
   * The frontend seeds its subgraph from the owner's anchor entity, so a
   * purely recency-ordered page is the wrong shape: once the account outgrows
   * NODE_LIMIT the anchor (usually among the oldest entities) and its
   * neighborhood fall off the page and the client renders an empty graph.
   *
   * But the neighborhood alone is the wrong shape too, and measurably so: the
   * BFS is first-come-first-served over whatever edges the anchor has, which
   * on a real account is one dominant type — it filled all 200 slots with
   * Persons while the account's 183k Communications, 108k Events, 37k Content
   * rows and 102 Locations never appeared at all. So the neighborhood is
   * capped at {@link ANCHOR_NEIGHBORHOOD_NODE_BUDGET} and the remaining budget
   * is WATERFILLED across every (non-excluded) entity type the account
   * actually has: types are visited scarcest-first, each takes at most an even
   * share of what is left, and a type too small to use its share donates the
   * remainder to the bigger ones. Every data type is represented; no type can
   * crowd out the rest; the per-type pages themselves are recency-ordered and
   * deterministic.
   *
   * The anchor itself is always kept, even when the explorer's entity-type
   * filter would exclude it (e.g. the user is a Person and Person is
   * deselected) — dropping it would collapse the client's anchor-seeded
   * subgraph to empty.
   */
  private async assembleOverviewNodes(
    ownerId: string,
    excludeEntityTypes: string[],
  ): Promise<Map<string, GraphNodeEntity>> {
    const excludedTypes = new Set(excludeEntityTypes);
    const nodeMap = new Map<string, GraphNodeEntity>();

    const userEntity = await this.graphQuery.getUserEntity(ownerId);
    if (userEntity) {
      nodeMap.set(userEntity.entity_id, userEntity);

      const { nodes: neighborhood } = await this.graphQuery.traverseGraph(ownerId, [userEntity.entity_id], {
        maxDepth: ANCHOR_NEIGHBORHOOD_DEPTH,
        maxNodes: NODE_LIMIT,
        maxEdges: ANCHOR_NEIGHBORHOOD_EDGE_LIMIT,
      });

      for (const node of neighborhood.values()) {
        if (nodeMap.size >= ANCHOR_NEIGHBORHOOD_NODE_BUDGET) {
          break;
        }

        if (excludedTypes.has(node.entity_type)) {
          continue;
        }

        nodeMap.set(node.entity_id, node);
      }
    }

    // Per-type waterfill over the remaining budget. Scarcest type first, so a
    // type with 13 nodes takes its 13 and donates the rest of its share to the
    // 183k-row types recomputed at each step, instead of wasting budget on a
    // share it cannot fill.
    const typeCounts = (await this.graphQuery.getEntityTypeCounts(ownerId))
      .filter((entry) => !excludedTypes.has(entry.entityType))
      .sort((a, b) => a.count - b.count);

    let remainingTypes = typeCounts.length;
    for (const { entityType } of typeCounts) {
      const remainingBudget = NODE_LIMIT - nodeMap.size;
      if (remainingBudget <= 0) {
        break;
      }

      const share = Math.max(1, Math.floor(remainingBudget / remainingTypes));
      remainingTypes -= 1;

      const nodes = await this.graphQuery.getNodes(ownerId, { entityType, limit: share });
      let taken = 0;
      for (const node of nodes) {
        if (taken >= share || nodeMap.size >= NODE_LIMIT) {
          break;
        }

        if (!nodeMap.has(node.entity_id)) {
          nodeMap.set(node.entity_id, node);
          taken += 1;
        }
      }
    }

    // Recency top-up for whatever budget the waterfill could not place (an
    // account whose types are all tiny, or heavy dup overlap with the
    // neighborhood).
    if (nodeMap.size < NODE_LIMIT) {
      const recentNodes = await this.graphQuery.getNodes(ownerId, {
        limit: NODE_LIMIT,
        excludeEntityTypes,
      });

      for (const node of recentNodes) {
        if (nodeMap.size >= NODE_LIMIT) {
          break;
        }

        if (!nodeMap.has(node.entity_id)) {
          nodeMap.set(node.entity_id, node);
        }
      }
    }

    return nodeMap;
  }

  /**
   * The DOTS overview: thousands of minimal nodes, zero edges — the payload
   * behind the graph view's zoomed-out "every data type as a tiny dot"
   * rendering. Edges arrive later, on interaction: focusing a dot fetches its
   * subgraph (`GET /graph/node`), zooming into a region fetches the edges
   * among the visible ids (`POST /graph/edges`).
   *
   * Same scarcest-first waterfill as the classic overview so every entity
   * type the account has is represented, but each type's share is the
   * highest-degree hubs first (not newest orphans). Payload is four fields
   * per node ({ id, type, name, degree } + `event_type` for events) — 2000
   * dots ship in roughly the bytes 200 full nodes did. Also returns
   * `connectivity` (related / isolated / relatedRatio) as the account-wide
   * relatedness metric.
   */
  @Get('dots')
  async getGraphDots(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(graphDotsSchema)) query: GraphDotsDto,
  ) {
    const ownerId = this.ensureUserId(ctx);

    const excludeEntityTypes =
      query.includeTypes === undefined ? [] : graphTypesToExclude(query.includeTypes);
    const excludedTypes = new Set(excludeEntityTypes);
    const budget = query.limit ?? DOTS_LIMIT;

    type DotNode = {
      entity_id: string;
      entity_type: string;
      name: string | null;
      event_type: string | null;
    };
    type DotNodeWithDegree = DotNode & { degree: number };
    const dots = new Map<string, DotNodeWithDegree>();

    const typeCountsRaw = await this.graphQuery.getEntityTypeCounts(ownerId);
    // Scarcest-first waterfill (see assembleOverviewNodes): a type too small
    // to use its share donates the remainder to the plentiful ones. Within each
    // type the pool is already highest-degree first (one degrees CTE).
    const typeCounts = typeCountsRaw
      .filter((entry) => !excludedTypes.has(entry.entityType))
      .sort((a, b) => a.count - b.count);

    const entityTypes = typeCounts.map((entry) => entry.entityType);

    const [connectivity, rankedPool, userEntity] = await Promise.all([
      this.graphQuery.getConnectivitySummary(ownerId, [...excludedTypes]),
      this.graphQuery.getRankedDotNodes(ownerId, {
        entityTypes,
        // Enough headroom for waterfill to pull a full budget from one plentiful type.
        perTypeLimit: budget,
        offset: query.offset,
        eventTypes: query.eventTypes,
      }),
      this.graphQuery.getUserEntity(ownerId),
    ]);

    // The anchor always ships (the client centers and seeds on it), even when
    // its type is deselected — same contract as the classic overview.
    if (userEntity) {
      const fromPool = rankedPool.find((node) => node.entity_id === userEntity.entity_id);
      const anchorDegrees =
        fromPool != null
          ? new Map([[userEntity.entity_id, fromPool.degree]])
          : await this.graphQuery.getDegreeCounts(ownerId, [userEntity.entity_id]);
      dots.set(userEntity.entity_id, {
        entity_id: userEntity.entity_id,
        entity_type: userEntity.entity_type,
        name: userEntity.name,
        event_type: null,
        degree: anchorDegrees.get(userEntity.entity_id) ?? 0,
      });
    }

    const poolByType = new Map<string, DotNodeWithDegree[]>();
    for (const node of rankedPool) {
      const list = poolByType.get(node.entity_type) ?? [];
      list.push(node);
      poolByType.set(node.entity_type, list);
    }

    const cursors = new Map<string, number>(entityTypes.map((type) => [type, 0]));
    let remainingTypes = typeCounts.length;
    for (const { entityType } of typeCounts) {
      const remainingBudget = budget - dots.size;
      if (remainingBudget <= 0) {
        break;
      }

      const share = Math.max(1, Math.floor(remainingBudget / remainingTypes));
      remainingTypes -= 1;

      const pool = poolByType.get(entityType) ?? [];
      let taken = 0;
      let cursor = cursors.get(entityType) ?? 0;
      while (taken < share && cursor < pool.length && dots.size < budget) {
        const node = pool[cursor];
        cursor += 1;
        if (!dots.has(node.entity_id)) {
          dots.set(node.entity_id, node);
          taken += 1;
        }
      }

      cursors.set(entityType, cursor);
    }

    // Donate leftover budget to still-plentiful types (degree order preserved).
    if (dots.size < budget) {
      for (const entityType of [...entityTypes].reverse()) {
        const pool = poolByType.get(entityType) ?? [];
        let cursor = cursors.get(entityType) ?? 0;
        while (cursor < pool.length && dots.size < budget) {
          const node = pool[cursor];
          cursor += 1;
          if (!dots.has(node.entity_id)) {
            dots.set(node.entity_id, node);
          }
        }

        cursors.set(entityType, cursor);
        if (dots.size >= budget) {
          break;
        }
      }
    }

    // Highest-degree first in the payload so progressive first-paint and the
    // client legend both see hubs before sparse orphans.
    const ranked = Array.from(dots.values()).sort((a, b) => b.degree - a.degree);

    return {
      success: true,
      data: {
        nodes: ranked.map((node) => ({
          id: node.entity_id,
          entity_id: node.entity_id,
          entity_type: node.entity_type,
          name: node.name,
          degree: node.degree,
          ...(node.event_type != null ? { event_type: node.event_type } : {}),
        })),
      },
      // Totals per type so the client can show "1,204 of 183k Communications"
      // and page later via (offset, limit).
      counts: Object.fromEntries(typeCounts.map((entry) => [entry.entityType, entry.count])),
      truncated: dots.size >= budget,
      // Key graph health metric: share of entities that touch ≥1 relationship.
      connectivity: {
        total: connectivity.total,
        related: connectivity.related,
        isolated: connectivity.isolated,
        relatedRatio: connectivity.relatedRatio,
      },
    };
  }

  /**
   * Section-edge fetch: the relationships among an explicit node-id set — the
   * client's current viewport once it zooms past the LOD threshold. Both
   * endpoints are constrained to the set server-side and the result is capped,
   * so a hub in view can't drag in its thousands of off-screen edges.
   */
  @Post('edges')
  async getGraphEdges(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(graphEdgesSchema)) body: GraphEdgesDto,
  ) {
    const ownerId = this.ensureUserId(ctx);

    const relationships = await this.graphQuery.getRelationshipsAmong(ownerId, body.ids, SECTION_EDGE_LIMIT);

    return {
      success: true,
      data: {
        links: relationships.map((rel) => ({
          id: rel.relationship_id,
          relationship_id: rel.relationship_id,
          source: rel.from_entity_id,
          target: rel.to_entity_id,
          relationship_type: rel.relationship_type,
          strength: rel.strength || 0.5,
          properties: rel.properties || {},
        })),
        truncated: relationships.length >= SECTION_EDGE_LIMIT,
      },
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

    const nodesById = new Map(Array.from(traversal.nodes.values()).map((n) => [n.entity_id, n]));
    const relationships: FocusEdge[] = [...traversal.edges];

    // Person↔communication ties live in ci.communications' participant columns,
    // not in ci.relationships, so the traversal above can never surface a
    // person's emails/messages (or a communication's people). Synthesize those
    // edges here so the focus graph shows them.
    const communicationTies =
      node.entity_type === 'Person'
        ? await this.graphQuery.getCommunicationTiesForPerson(
            ownerId,
            node.entity_id,
            FOCUS_COMMUNICATION_LIMIT,
          )
        : node.entity_type === 'Communication'
          ? await this.graphQuery.getPersonTiesForCommunication(ownerId, node.entity_id)
          : [];

    const edgeIds = new Set(relationships.map((rel) => rel.relationship_id));
    // The materialize-edges job writes these same ties as REAL relationships;
    // once the traversal returns one, synthesizing it again would draw a
    // duplicate link — so dedupe on the directed (from, to, type) triple too.
    const edgeTriples = new Set(
      relationships.map((rel) => `${rel.from_entity_id}|${rel.to_entity_id}|${rel.relationship_type}`),
    );
    for (const tie of communicationTies) {
      const other = tie.node;
      const personId = node.entity_type === 'Person' ? node.entity_id : other.entity_id;
      const communicationId = node.entity_type === 'Person' ? other.entity_id : node.entity_id;
      const relationshipType = tie.isSender ? 'SENT' : 'RECEIVED';
      const relationshipId = `comm-${communicationId}-${personId}-${relationshipType}`;
      const triple = `${personId}|${communicationId}|${relationshipType}`;

      if (edgeIds.has(relationshipId) || edgeTriples.has(triple)) {
        continue;
      }

      edgeIds.add(relationshipId);
      edgeTriples.add(triple);

      if (!nodesById.has(other.entity_id)) {
        nodesById.set(other.entity_id, other);
      }

      relationships.push({
        relationship_id: relationshipId,
        from_entity_id: personId,
        to_entity_id: communicationId,
        relationship_type: relationshipType,
        strength: tie.isSender ? 0.6 : 0.45,
        properties: { derived_from: 'communication_participants' },
        is_bidirectional: false,
      });
    }

    const traversalNodes = Array.from(nodesById.values());

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
