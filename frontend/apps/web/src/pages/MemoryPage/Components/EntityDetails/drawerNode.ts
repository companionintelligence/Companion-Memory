import { GlobalUID } from '@ci/common';
import { type ResultOf } from '@graphql-typed-document-node/core';

import { toGlobalResourceType } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { gql } from '@/graphql';

import type { EntityItem, GenericEntity } from '../../useEntityService';

/**
 * The same per-type selection the explorer's `search` connection makes for a
 * node (see SEARCH_QUERY in useEntityService.tsx), so the resolved node slots
 * into the typed *Details bodies. Keep the two in step: a field added to the
 * explorer's node selection that a details body relies on must be added here
 * too — `EntityDetails entity={node}` below stops typechecking otherwise.
 */
export const GET_DRAWER_NODE = gql(`
  query GetDrawerNode($id: ID!) {
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
        galleryMediaSize: size
      }

      ... on ContentType {
        galleryMimetype: mimetype
        galleryTitle: title
        galleryContentUrl: url
        galleryContentSourceUrl: sourceUrl
        galleryPreviewUrl: previewUrl
        galleryFileUrl: mediaUrl
        galleryPlaybackUrl: playbackUrl
        galleryMediaSize: mediaSize
      }

      ...AnswerGridItemData
      ...BrowserActivityGridItemData
      ...CommunicationGridItemData
      ...ConceptGridItemData
      ...ContentGridItemData
      ...EventGridItemData
      ...FileChunkGridItemData
      ...FileGridItemData
      ...NoteGridItemData
      ...ItemGridItemData
      ...PersonGridItemData
      ...PlaceGridItemData
      ...ProductGridItemData
      ...ReceiptGridItemData
      ...ThreadGridItemData

      ...TableAnswerRowData
      ...TableCommunicationRowData
      ...TableConceptRowData
      ...TableContentRowData
      ...TableEventRowData
      ...TableFileChunkRowData
      ...TableFileRowData
      ...TableItemRowData
      ...TableNoteRowData
      ...TablePersonRowData
      ...TablePlaceRowData
      ...TableProductRowData
      ...TableReceiptRowData
      ...TableThreadRowData
      ...TableBrowserActivityRowData

      ...TimelineBrowserActivityCardData
      ...TimelineCommunicationCardData
      ...TimelineEventCardData

      ... on CommunicationType {
        bucketTime: time
      }

      ... on BrowserActivityType {
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
        galleryMediaSize: mediaSize
        galleryTitle: title
        galleryLocationName: locationName
      }

      ... on PlaceType {
        mapProperties: properties
      }

      ...TimelineFileChunkCardData
    }
  }
`);

export type ResolvedNode = NonNullable<ResultOf<typeof GET_DRAWER_NODE>['node']>;
/** Node types the explorer search returns — the ones EntityDetails has a body for. */
export type DetailNode = Extract<ResolvedNode, { __typename: EntityItem['__typename'] }>;

const DETAIL_TYPENAMES: ReadonlySet<string> = new Set<EntityItem['__typename']>([
  'ActionType',
  'AnswerType',
  'BrowserActivityType',
  'CommunicationType',
  'ConceptType',
  'ContentType',
  'EventType',
  'FileChunkType',
  'FileType',
  'ItemType',
  'NoteType',
  'PersonType',
  'PlaceType',
  'ProductModelType',
  'ReceiptType',
  'ThreadType',
]);

export function isDetailNode(node: ResolvedNode): node is DetailNode {
  return DETAIL_TYPENAMES.has(node.__typename);
}

/** Global id for a graph-node stub, or null when its type has no GraphQL node. */
export function genericEntityGlobalId(entity: GenericEntity): string | null {
  const globalType = entity.entityType ? toGlobalResourceType(entity.entityType) : null;

  return globalType && entity.id ? GlobalUID.encode(globalType, entity.id) : null;
}
