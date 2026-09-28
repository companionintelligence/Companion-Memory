import { useCallback, useEffect, useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { Sheet } from '@ci/shadcn';

import { gql } from '@/graphql';
import { EntityDrawerHostProvider } from '@/pages/MemoryPage/Components/EntityDetails/drawerHost';
import { EntityDetails } from '@/pages/MemoryPage/Components/EntityDetails/EntityDetails';
import { withFresherEntity, type MemoryEntity } from '@/pages/MemoryPage/useEntityService';

/**
 * The selection the explorer makes for a PlaceType node, so the result slots
 * straight into the shared EntityDetails sheet (name/address/description
 * editing, tags, "Open full page") and shares its cache entry with the grid.
 */
export const GET_PLACE_SHEET = gql(`
  query GetPlaceSheet($id: ID!) {
    place(id: $id) {
      __typename
      id
      tags {
        label
      }
      # The explorer's own unmasked alias for the map; MemoryEntity requires it.
      mapProperties: properties
      ...PlaceGridItemData
      ...TablePlaceRowData
    }
  }
`);

/** Matches the Sheet's `data-[state=closed]:duration-300` close animation. */
const CLOSE_ANIMATION_MS = 300;

/**
 * Right-hand details drawer for the places list — the same drawer `/memory`
 * opens for a place, so a row click previews in place instead of leaving the
 * list. `placeId` is the GraphQL global id of the routed row (or null when
 * nothing is open). Closing always goes through `onClose` so the route stays
 * the source of truth.
 */
export function PlaceSheet({
  placeId,
  onClose,
  onChanged,
}: {
  placeId: string | null;
  onClose: () => void;
  /** Called after an edit/delete in the drawer so the list can refresh. */
  onChanged: () => void;
}) {
  const { data } = useQuery(GET_PLACE_SHEET, {
    variables: { id: placeId ?? '' },
    skip: placeId == null,
    fetchPolicy: 'cache-first',
  });

  // An entity pushed from inside the drawer (related-entity card) takes
  // precedence over the routed place until the drawer closes.
  const [pushedEntity, setPushedEntity] = useState<MemoryEntity | null>(null);
  // The last entity shown, kept through the close animation so the panel
  // doesn't blank before it slides out.
  const [lastEntity, setLastEntity] = useState<MemoryEntity | null>(null);

  const liveEntity = pushedEntity ?? data?.place ?? null;
  const open = placeId != null;

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
      // Only a pushed entity is a snapshot; the routed place is a watched
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
