import { useCallback, useState } from 'react';

import { useApolloClient } from '@apollo/client';
import { fetchJson, GlobalUID } from '@ci/common';

import type { GraphNode } from '@/api/useGraphOverview';
import { gql } from '@/graphql';

import type { MemoryEntity } from '../useEntityService';

/**
 * The record behind a graph node, as `/api/graph/source` reports it: `{ type, id }` in the
 * `GlobalUID` vocabulary, or `null` for a node with nothing addressable behind it.
 */
type GraphSourceResponse = {
  success: boolean;
  source: { type: string; id: string } | null;
};

/** Resource types `GlobalUID.encode` accepts. Not exported from @ci/common, so derived here. */
type ResourceType = Parameters<typeof GlobalUID.encode>[0];

/**
 * The graph node's real entity, selected exactly as the explorer's own `Search` query selects it
 * (same aliases, same fragments) so the result drops straight into the shared `EntityDetails`
 * sheet — the one List and Gallery open — instead of the name-and-type stub the canvas used to
 * show. Anything less than a field-for-field mirror and the detail bodies, which read their data
 * back through these fragments, would render blank.
 */
const GRAPH_NODE_ENTITY = gql(`
  query GraphNodeEntity($id: ID!) {
    node(id: $id) {
      __typename
      id

      ... on Taggable {
        tags {
          label
        }
      }

      ... on FileType {
        galleryContentType: contentType
        galleryFilename: filename
        galleryPreviewUrl: previewUrl
        gallerySourceUrl: sourceUrl
            galleryPlaybackUrl: playbackUrl
      }

      ... on ContentType {
        galleryMimetype: mimetype
        galleryTitle: title
        galleryContentUrl: url
        galleryContentSourceUrl: sourceUrl
      }

      ... on CommunicationType {
        bucketTime: time
      }

      ... on EventType {
        bucketStartTime: startTime
        eventType
        mapCoordinates: locationCoordinates
        galleryMediaContentType: mediaContentType
        galleryPreviewUrl: previewUrl
        gallerySourceUrl: mediaUrl
        galleryPlaybackUrl: playbackUrl
        galleryTitle: title
        galleryLocationName: locationName
      }

      ... on PlaceType {
        mapProperties: properties
      }

      ...CommunicationGridItemData
      ...ConceptGridItemData
      ...ContentGridItemData
      ...EventGridItemData
      ...FileGridItemData
      ...ItemGridItemData
      ...PersonGridItemData
      ...PlaceGridItemData

      ...TableCommunicationRowData
      ...TableConceptRowData
      ...TableContentRowData
      ...TableEventRowData
      ...TableFileRowData
      ...TableItemRowData
      ...TablePersonRowData
      ...TablePlaceRowData

      ...TimelineCommunicationCardData
      ...TimelineEventCardData
    }
  }
`);

/**
 * Entity types a graph node can resolve to — the GraphQL side of the backend's
 * `GRAPH_TYPE_TO_SOURCE` map. `node(id:)` returns the whole `Node` interface, so this both
 * narrows the union and guards against a source ref pointing at something the drawer has no body
 * for.
 */
const RESOLVABLE_TYPENAMES = [
  'CommunicationType',
  'ConceptType',
  'ContentType',
  'EventType',
  'FileType',
  'ItemType',
  'PersonType',
  'PlaceType',
] as const;

type ResolvableTypename = (typeof RESOLVABLE_TYPENAMES)[number];

function isResolvable(entity: {
  __typename?: string;
}): entity is Extract<MemoryEntity, { __typename: ResolvableTypename }> {
  return RESOLVABLE_TYPENAMES.includes(entity.__typename as ResolvableTypename);
}

/**
 * The fallback card: the graph node's own name/type/properties, routed to `GenericDetails`. Used
 * when the node stands for nothing addressable (Pet, Group, an unlinked mirror node) or the
 * lookup fails — the drawer still opens, it just shows what the canvas already knew.
 */
function genericEntity(node: GraphNode): MemoryEntity {
  return {
    __typename: 'GenericEntity',
    id: node.id,
    name: node.name,
    entityType: node.entity_type,
    description: node.description,
    properties: node.properties,
  };
}

/**
 * Resolves a clicked graph node to the same typed entity List/Gallery/Map hand to the detail
 * drawer. Two hops: `/api/graph/source` says which record the node stands for (the graph's
 * `entity_id` is not always the record's id — File mirrors prove it), then the GraphQL
 * `node(id:)` query fetches that record.
 *
 * Never rejects: a node with no source, a deleted record or a failed request all fall back to
 * the graph's own card, so "Details" always opens something.
 */
export function useGraphNodeEntity(authToken?: string | null) {
  const client = useApolloClient();
  const [resolving, setResolving] = useState(false);

  const resolveNodeEntity = useCallback(
    async (node: GraphNode): Promise<MemoryEntity> => {
      setResolving(true);

      try {
        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
        const sourceResponse = await fetchJson<GraphSourceResponse>(
          `/api/graph/source?entityId=${encodeURIComponent(node.entity_id ?? node.id)}`,
          { headers, credentials: 'include' },
        );

        const source = sourceResponse?.source;
        if (!source) {
          return genericEntity(node);
        }

        const { data } = await client.query({
          query: GRAPH_NODE_ENTITY,
          variables: { id: GlobalUID.encode(source.type as ResourceType, source.id) },
          fetchPolicy: 'cache-first',
        });

        const entity = data?.node;

        return entity && isResolvable(entity) ? entity : genericEntity(node);
      } catch {
        return genericEntity(node);
      } finally {
        setResolving(false);
      }
    },
    [authToken, client],
  );

  return { resolveNodeEntity, resolving };
}
