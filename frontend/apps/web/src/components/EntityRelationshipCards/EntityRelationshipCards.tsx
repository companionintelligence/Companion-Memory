import { useEffect, useMemo, useRef, useState } from 'react';

import { gql as apolloGql, useApolloClient } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Card } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { useNodeGraphService } from '@/api/useNodeGraphService';
import { Tag } from '@/components/Tag';

const CARD_MIN_WIDTH = 180;
const CARD_GAP_PX = 12;
const MAX_VISIBLE_CARDS = 10;
const DEFAULT_VISIBLE_CARDS = 5;

type RelationshipCard = {
  relationshipId: string;
  relationshipType: string;
  otherEntityId: string;
  otherEntityName: string;
  otherEntityType: string;
  otherEntityTags: string[];
  relationshipDetails: Array<{ label: string; value: string }>;
};

interface Props {
  entityId: string;
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
  | 'person'
  | 'place'
  | 'provider'
  | 'question'
  | 'saved-search'
  | 'summary'
  | 'tag'
  | 'thread'
  | 'user';

type NodeTagsResponse = {
  node?: {
    __typename?: string;
    tags?: Array<{ label?: string | null } | null> | null;
  } | null;
};

const GET_NODE_TAGS = apolloGql`
  query GetNodeTagsForRelationshipCard($id: ID!) {
    node(id: $id) {
      __typename
      ... on Taggable {
        tags {
          label
        }
      }
    }
  }
`;

const IGNORED_RELATIONSHIP_PROPERTIES = new Set([
  'id',
  'relationship_id',
  'relationshipId',
  'source',
  'target',
  'from_entity_id',
  'to_entity_id',
  'created_at',
  'updated_at',
]);

function formatRelationshipLabel(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatPropertyLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .split(' ')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatPropertyValue(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    return trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value
      .filter(
        (item): item is string | number | boolean =>
          typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
      )
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);

    if (items.length === 0) {
      return null;
    }

    const displayItems = items.slice(0, 3);
    const suffix = items.length > 3 ? ` +${items.length - 3}` : '';

    return `${displayItems.join(', ')}${suffix}`;
  }

  return null;
}

function extractRelationshipDetails(
  properties: Record<string, unknown> | undefined,
): Array<{ label: string; value: string }> {
  if (!properties) {
    return [];
  }

  const details: Array<{ label: string; value: string }> = [];

  for (const [key, value] of Object.entries(properties)) {
    if (IGNORED_RELATIONSHIP_PROPERTIES.has(key)) {
      continue;
    }

    const formattedValue = formatPropertyValue(value);
    if (!formattedValue) {
      continue;
    }

    details.push({
      label: formatPropertyLabel(key),
      value: formattedValue,
    });

    if (details.length >= 2) {
      break;
    }
  }

  return details;
}

function shuffleItems<T>(items: T[]): T[] {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = temp;
  }

  return shuffled;
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

function getEntityDetailPath(entityType: string, entityId: string): string | null {
  switch (entityType.toLowerCase()) {
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
    case 'event':
      return `/events/${entityId}`;
    case 'concept':
      return `/concepts/${entityId}`;
    case 'note':
      return `/notes/${entityId}`;
    default:
      return null;
  }
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

function toGlobalResourceType(entityType: string): GlobalResourceType | null {
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
    case 'person':
    case 'place':
    case 'provider':
    case 'question':
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

export function EntityRelationshipCards({ entityId }: Props) {
  const apolloClient = useApolloClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visibleCardCount, setVisibleCardCount] = useState(DEFAULT_VISIBLE_CARDS);
  const [tagsByEntityKey, setTagsByEntityKey] = useState<Record<string, string[]>>({});

  const { data, loading } = useNodeGraphService({
    entityId,
    maxDepth: 1,
    nodeLimit: 120,
    skip: !entityId,
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setVisibleCardCount(getVisibleCardCount(entry.contentRect.width));
      }
    });

    observer.observe(element);
    setVisibleCardCount(getVisibleCardCount(element.clientWidth));

    return () => observer.disconnect();
  }, []);

  const relationshipCards = useMemo<RelationshipCard[]>(() => {
    if (!data) {
      return [];
    }

    const nodeById = new Map(data.nodes.map((node) => [node.id, node]));

    return data.links
      .filter((link) => link.source === entityId || link.target === entityId)
      .map((link) => {
        const otherEntityId = link.source === entityId ? link.target : link.source;
        const otherNode = nodeById.get(otherEntityId);

        return {
          relationshipId: link.relationship_id,
          relationshipType: link.relationship_type,
          otherEntityId,
          otherEntityName: otherNode?.name ?? 'Unnamed Entity',
          otherEntityType: otherNode?.entity_type ?? 'unknown',
          otherEntityTags: extractTagsFromProperties(otherNode?.properties),
          relationshipDetails: extractRelationshipDetails(link.properties),
        };
      });
  }, [data, entityId]);

  const shuffledCards = useMemo(() => shuffleItems(relationshipCards), [relationshipCards]);
  const visibleCards = useMemo(
    () => shuffledCards.slice(0, visibleCardCount),
    [shuffledCards, visibleCardCount],
  );

  useEffect(() => {
    if (visibleCards.length === 0) {
      return;
    }

    let cancelled = false;

    const loadTags = async () => {
      const results = await Promise.all(
        visibleCards.map(async (card) => {
          const resourceType = toGlobalResourceType(card.otherEntityType);
          if (!resourceType) {
            return {
              key: getEntityLookupKey(card.otherEntityType, card.otherEntityId),
              labels: [],
            };
          }

          try {
            const gid = GlobalUID.encode(resourceType, card.otherEntityId);
            const response = await apolloClient.query<NodeTagsResponse>({
              query: GET_NODE_TAGS,
              variables: { id: gid },
              fetchPolicy: 'cache-first',
            });
            const labels = (response.data?.node?.tags ?? [])
              .map((tag) => tag?.label?.trim() ?? '')
              .filter((label): label is string => label.length > 0);

            return { key: getEntityLookupKey(card.otherEntityType, card.otherEntityId), labels };
          } catch {
            return {
              key: getEntityLookupKey(card.otherEntityType, card.otherEntityId),
              labels: [],
            };
          }
        }),
      );

      if (cancelled) {
        return;
      }

      setTagsByEntityKey((prev) => {
        const next = { ...prev };

        for (const result of results) {
          if (result.labels.length > 0) {
            next[result.key] = result.labels;
          }
        }

        return next;
      });
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
    <Card.Content className="p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {formatRelationshipLabel(card.relationshipType)}
          </p>
          <p className="text-sm font-semibold leading-tight line-clamp-2">{card.otherEntityName}</p>
        </div>
        <div className="flex max-w-[45%] flex-col items-end gap-1 text-right">
          <p className="text-xs text-muted-foreground uppercase">{card.otherEntityType}</p>
          {tags.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1">
              {tags.map((tag) => (
                <Tag
                  key={`${card.relationshipId}-${tag}`}
                  text={tag}
                  className="h-5 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {card.relationshipDetails.length > 0 && (
        <div className="border-t border-border/50 pt-2 flex flex-wrap gap-x-3 gap-y-1">
          {card.relationshipDetails.map((detail) => (
            <p key={`${card.relationshipId}-${detail.label}`} className="text-xs leading-tight">
              <span className="text-muted-foreground">{detail.label}:</span>{' '}
              <span className="text-foreground/85">{detail.value}</span>
            </p>
          ))}
        </div>
      )}
    </Card.Content>
  );

  return (
    <div ref={containerRef} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Relationship Cards
        </h2>
      </div>

      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, visibleCards.length)}, minmax(0, 1fr))`,
        }}
      >
        {loading &&
          Array.from({ length: visibleCardCount }).map((_, idx) => (
            <Card key={`loading-${idx}`} className="p-0 min-h-[96px] animate-pulse">
              <Card.Content className="p-3 flex flex-col gap-2">
                <div className="h-4 w-2/3 rounded bg-muted" />
                <div className="h-3 w-1/2 rounded bg-muted" />
              </Card.Content>
            </Card>
          ))}

        {!loading &&
          visibleCards.map((card) => {
            const detailPath = getEntityDetailPath(card.otherEntityType, card.otherEntityId);
            const lookupKey = getEntityLookupKey(card.otherEntityType, card.otherEntityId);
            const tags = (tagsByEntityKey[lookupKey] ?? card.otherEntityTags).slice(0, 3);

            if (!detailPath) {
              return (
                <Card key={card.relationshipId} className="p-0 min-h-[96px]">
                  {renderCardContent(card, tags)}
                </Card>
              );
            }

            return (
              <Link key={card.relationshipId} to={detailPath} className="block">
                <Card className="p-0 min-h-[96px] transition-colors hover:bg-accent/40">
                  {renderCardContent(card, tags)}
                </Card>
              </Link>
            );
          })}
      </div>
    </div>
  );
}
