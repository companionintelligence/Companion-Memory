import { useEffect, useMemo, useState } from 'react';

import { gql as apolloGql, useApolloClient } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Button, Card, cn } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { useNodeGraphService } from '@/api/useNodeGraphService';
import { ChatAbout } from '@/components/ChatWithAgent';
import { Tag } from '@/components/Tag';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import { namedChatContext } from '@/lib/agentChat';

import {
  filterDisplayTags,
  formatCardWhen,
  formatNeighborKind,
  formatRelationshipPhrase,
  pickCardSummary,
} from './relationshipCardDisplay';

const CARD_MIN_WIDTH = 180;
const CARD_GAP_PX = 12;
const MAX_VISIBLE_CARDS = 10;
const DEFAULT_VISIBLE_CARDS = 5;
/** Grid items default to min-width:auto, so a nowrap tag or long subject
 *  expands the track and paints off the rounded card. min-w-0 + clip keeps
 *  every child inside the tile. */
const CARD_SHELL = 'min-h-[96px] min-w-0 max-w-full overflow-hidden p-0';

type RelationshipCard = {
  relationshipId: string;
  relationshipType: string;
  otherEntityId: string;
  otherEntityName: string;
  otherEntityType: string;
  otherEntityTags: string[];
  otherEntityDescription: string | null;
  otherEntityProperties: Record<string, unknown>;
  relationshipProperties: Record<string, unknown>;
  relationshipPhrase: string | null;
  summary: string | null;
  when: string | null;
  /** Relationship weight (graph link strength), used for stable ordering. */
  strength: number;
  /** Most recent timestamp on the link, used as a secondary sort key. */
  recency: number;
};

/** Payload for opening a related entity from a relationship card (memory drawer). */
export type RelatedEntityOpenTarget = {
  id: string;
  name: string;
  entityType: string;
  description: string | null;
  properties: Record<string, unknown>;
};

type NodeTags = {
  __typename?: string;
  tags?: Array<{ label?: string | null } | null> | null;
} | null;

interface Props {
  entityId: string;
  /**
   * When set (memory drawer), card clicks open the related entity in-sheet
   * instead of navigating to a full-page route. Full-page entity screens omit
   * this and keep the default `<Link>` behavior.
   */
  onOpenRelatedEntity?: (target: RelatedEntityOpenTarget) => void;
  /** Restrict to these relationship types (e.g. excluding ones another section on the same page already shows). */
  relationshipTypes?: string[];
  /** Restrict to neighbors of these entity types. */
  entityTypes?: string[];
  /** Overrides the default "Connections" heading. */
  heading?: string;
}

type GlobalResourceType =
  | 'action'
  | 'answer'
  | 'browser-activity'
  | 'communication'
  | 'concept'
  | 'connection'
  | 'content'
  | 'event'
  | 'fact'
  | 'file'
  | 'item'
  | 'message'
  | 'note'
  | 'observation'
  | 'person'
  | 'place'
  | 'product'
  | 'provider'
  | 'question'
  | 'receipt'
  | 'receipt-line-item'
  | 'saved-search'
  | 'summary'
  | 'tag'
  | 'thread'
  | 'user';

/** Response shape for the dynamically-aliased batched tags query (n0, n1, …). */
type BatchNodeTagsResponse = Record<string, NodeTags>;

/**
 * Build a single query that fetches tags for many nodes at once via aliased
 * `node(id:)` selections — one request instead of one per card (avoids N+1).
 */
function buildBatchNodeTagsQuery(count: number) {
  const variableDefs = Array.from({ length: count }, (_, i) => `$id${i}: ID!`).join(', ');
  const selections = Array.from(
    { length: count },
    (_, i) => `n${i}: node(id: $id${i}) { __typename ... on Taggable { tags { label } } }`,
  ).join('\n    ');

  return apolloGql(`
  query GetNodeTagsForRelationshipCards(${variableDefs}) {
    ${selections}
  }
`);
}

/** Pull the most recent timestamp from a link's properties for stable ordering. */
function extractRecency(properties: Record<string, unknown> | undefined): number {
  if (!properties) {
    return 0;
  }

  for (const key of ['updated_at', 'last_seen', 'created_at', 'timestamp', 'time']) {
    const value = properties[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value);

      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

function getVisibleCardCount(width: number): number {
  if (width <= 0) {
    return DEFAULT_VISIBLE_CARDS;
  }

  const cardsPerRow = Math.max(1, Math.floor((width + CARD_GAP_PX) / (CARD_MIN_WIDTH + CARD_GAP_PX)));

  if (width >= 1200) {
    return Math.min(MAX_VISIBLE_CARDS, Math.max(DEFAULT_VISIBLE_CARDS, cardsPerRow));
  }

  return Math.min(MAX_VISIBLE_CARDS, cardsPerRow);
}

export function getEntityDetailPath(entityType: string, entityId: string): string | null {
  switch (normalizeGraphEntityType(entityType)) {
    case 'person':
      return `/people/${entityId}`;
    case 'place':
      return `/places/${entityId}`;
    case 'content':
      return `/content/${entityId}`;
    case 'communication':
      return `/communications/${entityId}`;
    case 'item':
      return `/items/${entityId}`;
    case 'product':
      // Deliberate: a catalog MODEL has no standalone page. Listed anyway so
      // the next reader does not add one by reflex — the drawer (ProductDetails)
      // is currently the whole surface, and a route that 404s would be worse
      // than no link at all.
      return null;
    case 'receipt':
      return `/receipts/${entityId}`;
    case 'event':
      return `/events/${entityId}`;
    case 'concept':
      return `/concepts/${entityId}`;
    case 'note':
      return `/notes/${entityId}`;
    case 'file':
      // Files have no standalone page. `/memory/content/:id` used to open a
      // file viewer but now addresses a ci.content row, so a file id there
      // would open nothing — better no link than a dead one.
      return null;
    default:
      return null;
  }
}

/**
 * Prefer the neighbor entity; when the edge only *references* a communication
 * in properties (derived_from / source ids), surface that communication id so
 * the card can still deep-link to the message.
 */
export function resolveRelatedEntityTarget(card: {
  otherEntityId: string;
  otherEntityName: string;
  otherEntityType: string;
  otherEntityDescription: string | null;
  otherEntityProperties: Record<string, unknown>;
  relationshipProperties?: Record<string, unknown>;
}): RelatedEntityOpenTarget {
  const normalizedType = normalizeGraphEntityType(card.otherEntityType);

  if (getEntityDetailPath(normalizedType, card.otherEntityId) || normalizedType === 'communication') {
    return {
      id: card.otherEntityId,
      name: card.otherEntityName,
      entityType: card.otherEntityType,
      description: card.otherEntityDescription,
      properties: card.otherEntityProperties,
    };
  }

  const props = card.relationshipProperties ?? {};
  const candidateKeys = [
    'communication_id',
    'communicationId',
    'source_communication_id',
    'sourceCommunicationId',
    'source_id',
    'sourceId',
  ];

  for (const key of candidateKeys) {
    const value = props[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        id: value.trim(),
        name: card.otherEntityName,
        entityType: 'communication',
        description: card.otherEntityDescription,
        properties: {},
      };
    }
  }

  return {
    id: card.otherEntityId,
    name: card.otherEntityName,
    entityType: card.otherEntityType,
    description: card.otherEntityDescription,
    properties: card.otherEntityProperties,
  };
}

function extractTagsFromProperties(properties: Record<string, unknown> | undefined): string[] {
  if (!properties) {
    return [];
  }

  const candidateKeys = ['tags', 'tagLabels', 'tag_labels', 'tagNames', 'tag_names'];

  for (const key of candidateKeys) {
    const value = properties[key];

    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
  }

  return [];
}

function normalizeGraphEntityType(entityType: string): string {
  return entityType.toLowerCase().replace(/_/g, '-');
}

export function toGlobalResourceType(entityType: string): GlobalResourceType | null {
  const normalized = normalizeGraphEntityType(entityType);

  switch (normalized) {
    case 'action':
    case 'answer':
    case 'browser-activity':
    case 'communication':
    case 'concept':
    case 'connection':
    case 'content':
    case 'event':
    case 'fact':
    case 'file':
    case 'item':
    case 'message':
    case 'note':
    case 'observation':
    case 'person':
    case 'place':
    case 'product':
    case 'provider':
    case 'question':
    case 'receipt':
    case 'receipt-line-item':
    case 'saved-search':
    case 'summary':
    case 'tag':
    case 'thread':
    case 'user':
      return normalized;
    default:
      return null;
  }
}

function getEntityLookupKey(entityType: string, entityId: string): string {
  return `${normalizeGraphEntityType(entityType)}:${entityId}`;
}

export function EntityRelationshipCards({
  entityId,
  onOpenRelatedEntity,
  relationshipTypes,
  entityTypes,
  heading = 'Connections',
}: Props) {
  const apolloClient = useApolloClient();
  const fmt = useDateTimeFormat();
  // A callback ref held in state, not a ref object: the card returns null until
  // its graph arrives, so on the first render there is no element, and an effect
  // keyed on nothing ran once against that null and never measured the row.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [visibleCardCount, setVisibleCardCount] = useState(DEFAULT_VISIBLE_CARDS);
  const [expanded, setExpanded] = useState(false);
  const [tagsByEntityKey, setTagsByEntityKey] = useState<Record<string, string[]>>({});

  const { data, loading } = useNodeGraphService({
    entityId,
    maxDepth: 1,
    nodeLimit: 120,
    skip: !entityId,
  });

  useEffect(() => {
    if (!container) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setVisibleCardCount(getVisibleCardCount(entry.contentRect.width));
      }
    });

    observer.observe(container);
    setVisibleCardCount(getVisibleCardCount(container.clientWidth));

    return () => observer.disconnect();
  }, [container]);

  const relationshipCards = useMemo<RelationshipCard[]>(() => {
    if (!data) {
      return [];
    }

    const nodeById = new Map(data.nodes.map((node) => [node.id, node]));
    const typeAllowlist = relationshipTypes ? new Set(relationshipTypes) : null;
    const entityAllowlist = entityTypes
      ? new Set(entityTypes.map((type) => normalizeGraphEntityType(type)))
      : null;

    return data.links
      .filter((link) => link.source === entityId || link.target === entityId)
      .filter((link) => !typeAllowlist || typeAllowlist.has(link.relationship_type))
      .map((link) => {
        const otherEntityId = link.source === entityId ? link.target : link.source;
        const otherNode = nodeById.get(otherEntityId);
        const otherEntityName = otherNode?.name ?? 'Unnamed Entity';
        const otherEntityDescription = otherNode?.description ?? null;
        const otherEntityProperties = otherNode?.properties ?? {};
        const relationshipProperties = link.properties ?? {};
        const recency = extractRecency(link.properties);

        return {
          relationshipId: link.relationship_id,
          relationshipType: link.relationship_type,
          otherEntityId,
          otherEntityName,
          otherEntityType: otherNode?.entity_type ?? 'unknown',
          otherEntityTags: extractTagsFromProperties(otherNode?.properties),
          otherEntityDescription,
          otherEntityProperties,
          relationshipPhrase: formatRelationshipPhrase(link.relationship_type, {
            focusIsSource: link.source === entityId,
            relationshipProperties,
          }),
          summary: pickCardSummary({
            name: otherEntityName,
            description: otherEntityDescription,
            entityProperties: otherEntityProperties,
          }),
          when: formatCardWhen(recency, fmt),
          strength: typeof link.strength === 'number' ? link.strength : 0,
          recency,
          // Stash raw link props for communication id recovery in the click handler.
          relationshipProperties,
        };
      })
      .filter(
        (card) => !entityAllowlist || entityAllowlist.has(normalizeGraphEntityType(card.otherEntityType)),
      );
  }, [data, entityId, relationshipTypes, entityTypes, fmt]);

  // Deterministic ordering: strongest first, then most recent, then a stable
  // id tiebreak — so the same relationships always surface (no random subset).
  const sortedCards = useMemo(
    () =>
      [...relationshipCards].sort((a, b) => {
        if (b.strength !== a.strength) {
          return b.strength - a.strength;
        }

        if (b.recency !== a.recency) {
          return b.recency - a.recency;
        }

        return a.relationshipId.localeCompare(b.relationshipId);
      }),
    [relationshipCards],
  );

  const collapsedCount = Math.min(visibleCardCount, sortedCards.length);
  const hasMore = sortedCards.length > collapsedCount;
  const visibleCards = useMemo(
    () => (expanded ? sortedCards : sortedCards.slice(0, collapsedCount)),
    [sortedCards, expanded, collapsedCount],
  );

  useEffect(() => {
    if (visibleCards.length === 0) {
      return;
    }

    let cancelled = false;

    const loadTags = async () => {
      // Collect the cards whose type maps to a tag-bearing node, then fetch all
      // of their tags in a single batched query rather than one request per card.
      const targets = visibleCards
        .map((card) => {
          const resourceType = toGlobalResourceType(card.otherEntityType);
          if (!resourceType) {
            return null;
          }

          return {
            key: getEntityLookupKey(card.otherEntityType, card.otherEntityId),
            gid: GlobalUID.encode(resourceType, card.otherEntityId),
          };
        })
        .filter((target): target is { key: string; gid: string } => target !== null);

      if (targets.length === 0) {
        return;
      }

      const query = buildBatchNodeTagsQuery(targets.length);
      const variables = Object.fromEntries(targets.map((target, i) => [`id${i}`, target.gid]));

      try {
        const response = await apolloClient.query<BatchNodeTagsResponse>({
          query,
          variables,
          fetchPolicy: 'cache-first',
        });

        if (cancelled) {
          return;
        }

        setTagsByEntityKey((prev) => {
          const next = { ...prev };

          targets.forEach((target, i) => {
            const labels = (response.data?.[`n${i}`]?.tags ?? [])
              .map((tag) => tag?.label?.trim() ?? '')
              .filter((label): label is string => label.length > 0);

            if (labels.length > 0) {
              next[target.key] = labels;
            }
          });

          return next;
        });
      } catch {
        // Leave the graph-node fallback tags in place if the batch fetch fails.
      }
    };

    void loadTags();

    return () => {
      cancelled = true;
    };
  }, [apolloClient, visibleCards]);

  if (!loading && relationshipCards.length === 0) {
    return null;
  }

  const renderCardContent = (card: RelationshipCard, tags: string[]) => (
    <Card.Content className="flex min-w-0 flex-col gap-2 overflow-hidden p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="line-clamp-3 text-sm font-semibold leading-tight [overflow-wrap:anywhere]">
          {card.otherEntityName}
        </p>
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          {card.relationshipPhrase ? (
            <p className="min-w-0 truncate text-xs text-muted-foreground">{card.relationshipPhrase}</p>
          ) : (
            <span />
          )}
          <p className="shrink-0 text-xs text-muted-foreground">
            {formatNeighborKind(card.otherEntityType, card.otherEntityProperties)}
          </p>
        </div>
      </div>

      {card.summary && (
        <p className="line-clamp-3 text-xs leading-snug text-foreground/80 [overflow-wrap:anywhere]">
          {card.summary}
        </p>
      )}

      {(card.when || tags.length > 0) && (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
          {card.when && <p className="shrink-0 text-[11px] text-muted-foreground">{card.when}</p>}
          {tags.map((tag) => (
            <Tag
              key={`${card.relationshipId}-${tag}`}
              text={tag}
              className="h-5 max-w-full min-w-0 shrink truncate px-1.5 py-0 text-[10px] font-medium"
            />
          ))}
        </div>
      )}
    </Card.Content>
  );

  return (
    <div ref={setContainer} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h2>
        {!loading && sortedCards.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Showing {visibleCards.length} of {sortedCards.length}
            </span>
            {(hasMore || expanded) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? 'Show less' : 'Show more'}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Always wrap at CARD_MIN_WIDTH — never force N equal columns in one row
          (that squashes cards in the memory detail sheet). */}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${CARD_MIN_WIDTH}px), 1fr))`,
        }}
      >
        {loading &&
          Array.from({ length: Math.max(1, visibleCardCount) }).map((_, idx) => (
            <Card key={`loading-${idx}`} className={cn(CARD_SHELL, 'animate-pulse')}>
              <Card.Content className="p-3 flex flex-col gap-2">
                <div className="h-4 w-2/3 rounded bg-muted" />
                <div className="h-3 w-1/2 rounded bg-muted" />
              </Card.Content>
            </Card>
          ))}

        {!loading &&
          visibleCards.map((card) => {
            const target = resolveRelatedEntityTarget(card);
            const detailPath = getEntityDetailPath(target.entityType, target.id);
            const lookupKey = getEntityLookupKey(card.otherEntityType, card.otherEntityId);
            const tags = filterDisplayTags(
              tagsByEntityKey[lookupKey] ?? card.otherEntityTags,
              card.otherEntityType,
            ).slice(0, 3);
            const cardClassName = cn(
              CARD_SHELL,
              'transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            );
            const chatContext = namedChatContext({
              title: target.name,
              body: target.description,
              sourceKind: target.entityType,
              sourceId: target.id,
            });

            if (onOpenRelatedEntity) {
              return (
                <ChatAbout key={card.relationshipId} context={chatContext} className="min-w-0 max-w-full">
                  <button
                    type="button"
                    className="block min-w-0 w-full max-w-full rounded-xl text-left"
                    onClick={() => onOpenRelatedEntity(target)}
                  >
                    <Card className={cardClassName}>{renderCardContent(card, tags)}</Card>
                  </button>
                </ChatAbout>
              );
            }

            if (!detailPath) {
              return (
                <ChatAbout key={card.relationshipId} context={chatContext} className="min-w-0 max-w-full">
                  <Card className={CARD_SHELL}>{renderCardContent(card, tags)}</Card>
                </ChatAbout>
              );
            }

            return (
              <ChatAbout key={card.relationshipId} context={chatContext} className="min-w-0 max-w-full">
                <Link to={detailPath} className="block min-w-0 max-w-full">
                  <Card className={cardClassName}>{renderCardContent(card, tags)}</Card>
                </Link>
              </ChatAbout>
            );
          })}
      </div>
    </div>
  );
}
