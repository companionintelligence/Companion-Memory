import { useCallback, useEffect, useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { Sheet } from '@ci/shadcn';

import { gql } from '@/graphql';
import { EntityDrawerHostProvider } from '@/pages/MemoryPage/Components/EntityDetails/drawerHost';
import { EntityDetails } from '@/pages/MemoryPage/Components/EntityDetails/EntityDetails';
import { withFresherEntity, type MemoryEntity } from '@/pages/MemoryPage/useEntityService';

/**
 * Same selection the explorer's search connection makes for a ContentType node,
 * so the result slots straight into the shared EntityDetails sheet (and shares
 * the cache entry with the grid tile, which spreads ContentGridItemData too).
 */
const GET_CONTENT_SHEET = gql(`
  query GetContentSheet($id: ID!) {
    content(id: $id) {
      __typename
      id
      tags {
        label
      }
      ...ContentGridItemData
      ...TableContentRowData
    }
  }
`);

/** Matches the Sheet's `data-[state=closed]:duration-300` close animation. */
const CLOSE_ANIMATION_MS = 300;

/**
 * Right-hand details drawer for the content library. `contentId` is the GraphQL
 * global id of the routed row (or null when nothing is open). The drawer's
 * "related" cards can swap in another entity without changing the URL; closing
 * always goes back through `onClose` so the route stays the source of truth.
 */
export function ContentSheet({
  contentId,
  onClose,
  onChanged,
}: {
  contentId: string | null;
  onClose: () => void;
  /** Called after a delete/restore in the drawer so the grid can refresh. */
  onChanged: () => void;
}) {
  const { data } = useQuery(GET_CONTENT_SHEET, {
    variables: { id: contentId ?? '' },
    skip: contentId == null,
    fetchPolicy: 'cache-first',
  });

  // An entity pushed from inside the drawer (related-entity card) takes
  // precedence over the routed content row until the drawer closes.
  const [pushedEntity, setPushedEntity] = useState<MemoryEntity | null>(null);
  // The last entity shown, kept through the close animation so the panel
  // doesn't blank before it slides out.
  const [lastEntity, setLastEntity] = useState<MemoryEntity | null>(null);

  const liveEntity = pushedEntity ?? data?.content ?? null;
  const open = contentId != null;

  useEffect(() => {
    if (!open) {
      setPushedEntity(null);

      const timer = window.setTimeout(() => setLastEntity(null), CLOSE_ANIMATION_MS);

      return () => window.clearTimeout(timer);
    }

    if (liveEntity) {
      setLastEntity(liveEntity);
    }
  }, [open, liveEntity]);

  const host = useMemo(
    () => ({
      setActiveEntity: (entity: MemoryEntity | null) => {
        if (entity == null) {
          onClose();
        } else {
          setPushedEntity(entity);
        }
      },
      // Only a pushed entity is a snapshot; the routed content row is a watched
      // query and already re-reads whatever the refetch wrote to the cache.
      refreshActiveEntity: (entity: MemoryEntity) => {
        setPushedEntity((current) => withFresherEntity(current, entity));
      },
      refetch: onChanged,
    }),
    [onClose, onChanged],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        onClose();
      }
    },
    [onClose],
  );

  const entity = open ? liveEntity : lastEntity;

  if (entity == null) {
    return null;
  }

  return (
    <EntityDrawerHostProvider value={host}>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <EntityDetails entity={entity} />
      </Sheet>
    </EntityDrawerHostProvider>
  );
}
