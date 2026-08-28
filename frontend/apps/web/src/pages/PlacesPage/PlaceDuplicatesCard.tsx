import { useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { AlertDialog, Badge, Button, Card } from '@ci/shadcn';
import { Merge } from '@ci/shadcn/icons';

import { gql } from '@/graphql';
import type { GetPlaceDuplicatesQuery } from '@/graphql/graphql';

/** Duplicate groups per page. Offset-based — the groups are recomputed per request. */
export const PLACE_DUPLICATE_PAGE_SIZE = 20;

export const GET_PLACE_DUPLICATES = gql(`
  query GetPlaceDuplicates($limit: Int, $offset: Int) {
    placeDuplicates(limit: $limit, offset: $offset) {
      totalCount
      hasMore
      groups {
        reason
        value
        totalPlaces
        places {
          id
          name
          description
          placeKind
          properties
        }
      }
    }
  }
`);

export const MERGE_PLACES = gql(`
  mutation MergePlaces($input: MergePlacesInput!) {
    mergePlaces(input: $input) {
      success
      place {
        id
        name
      }
      counts {
        events
        childPlaces
        relationshipsFrom
        relationshipsTo
      }
    }
  }
`);

export const REJECT_PLACE_DUPLICATES = gql(`
  mutation RejectPlaceDuplicates($placeIds: [ID!]!) {
    rejectPlaceDuplicates(placeIds: $placeIds)
  }
`);

type DuplicateGroup = GetPlaceDuplicatesQuery['placeDuplicates']['groups'][number];
type DuplicatePlace = DuplicateGroup['places'][number];

const DUPLICATE_REASON_LABELS: Record<DuplicateGroup['reason'], string> = {
  PLACE_ID: 'Same map place',
  NAME_PROXIMITY: 'Same name, within 150 m',
};

type PlaceProperties = {
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  source?: string | null;
};

/** The one-line summary under a place's name: address, else coordinates, plus where it came from. */
function describePlace(place: DuplicatePlace): string {
  const properties = (place.properties ?? {}) as PlaceProperties;
  const lat = properties.latitude ?? properties.lat;
  const lng = properties.longitude ?? properties.lng;
  const where =
    properties.address?.trim() ||
    (lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null);

  return [where, place.placeKind, properties.source?.replace(/_/g, ' ')].filter(Boolean).join(' · ') || '—';
}

/**
 * One duplicate-place suggestion and the two answers a person can give it.
 * Both stick: a merge tombstones the sources, and "not the same place" writes
 * every pair to `ci.entity_merge_blocks`, which the finder reads before it
 * proposes anything — otherwise the same group would come back on every load.
 */
function PlaceDuplicateGroupRow({
  group,
  onMerged,
}: {
  group: DuplicateGroup;
  onMerged: () => Promise<unknown>;
}) {
  const [mergePlaces, { loading }] = useMutation(MERGE_PLACES);
  const [rejectDuplicates, { loading: rejecting }] = useMutation(REJECT_PLACE_DUPLICATES);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const truncated = group.totalPlaces > group.places.length;
  const defaultTargetId = group.places[0]?.id ?? null;
  const pendingTarget = group.places.find((place) => place.id === pendingTargetId);

  const merge = async (targetId: string) => {
    const sourceIds = group.places.map((place) => place.id).filter((id) => id !== targetId);

    try {
      await mergePlaces({ variables: { input: { targetId, sourceIds } } });
      setPendingTargetId(null);
      setMergeError(null);
      await onMerged();
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'The merge failed. Please try again.');
    }
  };

  const reject = async () => {
    try {
      await rejectDuplicates({ variables: { placeIds: group.places.map((place) => place.id) } });
      setMergeError(null);
      await onMerged();
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Could not record that. Please try again.');
    }
  };

  const others = group.places.length - 1;

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Merge className="h-4 w-4" />
        <span>
          {DUPLICATE_REASON_LABELS[group.reason]}:{' '}
          <span className="font-medium text-foreground">{group.value}</span>
        </span>
      </div>

      {truncated && (
        <div className="mb-2 text-xs text-muted-foreground">
          {`Showing ${group.places.length} of ${group.totalPlaces} places sharing this — merging affects only the ${group.places.length} shown.`}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {group.places.map((place) => (
          <div
            key={place.id}
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{place.name || 'Unnamed place'}</div>
              <div className="truncate text-sm text-muted-foreground">{describePlace(place)}</div>
            </div>

            <Button
              size="sm"
              variant="ghost"
              className="self-start sm:self-auto shrink-0"
              disabled={loading}
              onClick={() => {
                setMergeError(null);
                setPendingTargetId(place.id);
              }}
            >
              Use as the kept place
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t pt-2">
        {mergeError && pendingTargetId == null && (
          <span className="text-sm text-destructive">{mergeError}</span>
        )}
        <Button size="sm" variant="ghost" disabled={loading || rejecting} onClick={() => void reject()}>
          {rejecting ? 'Saving…' : 'Not the same place'}
        </Button>
        <Button
          size="sm"
          disabled={loading || rejecting || defaultTargetId == null}
          onClick={() => {
            if (defaultTargetId != null) {
              setMergeError(null);
              setPendingTargetId(defaultTargetId);
            }
          }}
        >
          Merge into one place
        </Button>
      </div>

      <AlertDialog
        open={pendingTargetId != null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTargetId(null);
          }
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Merge into one place?</AlertDialog.Title>
            <AlertDialog.Description>
              {`Events, visits, things, receipts and home/work links from the other ${others === 1 ? 'place' : `${others} places`} will move onto "${pendingTarget?.name || 'Unnamed place'}". This cannot be undone from the UI.`}
            </AlertDialog.Description>
          </AlertDialog.Header>
          {mergeError && <div className="text-sm text-destructive">{mergeError}</div>}
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={loading}>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              disabled={loading || pendingTargetId == null}
              onClick={(e) => {
                // Radix auto-closes on Action click; keep the dialog open so a
                // failure (or the in-flight state) stays visible.
                e.preventDefault();
                if (pendingTargetId != null) {
                  void merge(pendingTargetId);
                }
              }}
            >
              {loading ? 'Merging…' : 'Merge into one place'}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </div>
  );
}

/**
 * "Possible duplicate places" for the Places page: the retroactive half of
 * place dedupe. Creation-time checks (provider place_id, snap cell, and same
 * name within 150 m) stop new twins; this card is how the ones that already
 * exist get folded. Renders nothing when there is nothing to review.
 */
export function PlaceDuplicatesCard({ onMerged }: { onMerged: () => Promise<unknown> }) {
  const [pages, setPages] = useState(1);
  const { data, error, refetch, fetchMore } = useQuery(GET_PLACE_DUPLICATES, {
    variables: { limit: PLACE_DUPLICATE_PAGE_SIZE, offset: 0 },
    notifyOnNetworkStatusChange: true,
  });

  const duplicates = data?.placeDuplicates;
  const groups = duplicates?.groups ?? [];

  const loadMore = () => {
    setPages((current) => current + 1);

    void fetchMore({
      variables: { offset: pages * PLACE_DUPLICATE_PAGE_SIZE },
      updateQuery: (prev, { fetchMoreResult }) => {
        if (!fetchMoreResult?.placeDuplicates) {
          return prev;
        }

        const seen = new Set(
          (prev.placeDuplicates?.groups ?? []).map((group) => `${group.reason}:${group.value}`),
        );

        return {
          placeDuplicates: {
            ...fetchMoreResult.placeDuplicates,
            groups: [
              ...(prev.placeDuplicates?.groups ?? []),
              ...fetchMoreResult.placeDuplicates.groups.filter(
                (group) => !seen.has(`${group.reason}:${group.value}`),
              ),
            ],
          },
        };
      },
    });
  };

  const handleMerged = async () => {
    setPages(1);
    await Promise.all([refetch({ limit: PLACE_DUPLICATE_PAGE_SIZE, offset: 0 }), onMerged()]);
  };

  if (error) {
    return (
      <div className="text-sm text-muted-foreground">
        Duplicate suggestions are unavailable right now ({error.message}).
      </div>
    );
  }

  if (groups.length === 0) {
    return null;
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title className="flex items-center gap-2 text-base">
          <Merge className="h-4 w-4" />
          Possible duplicate places
          <Badge variant="secondary">{duplicates?.totalCount ?? 0}</Badge>
        </Card.Title>
        <Card.Description>
          These places share a map identity, or the same name within 150 m of each other. Merge them to fold
          their events and links into one, or say they are different so they are not proposed again.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex max-h-[40em] flex-col gap-3 overflow-y-auto">
        {groups.map((group) => (
          <PlaceDuplicateGroupRow
            key={`${group.reason}:${group.value}`}
            group={group}
            onMerged={handleMerged}
          />
        ))}

        {duplicates?.hasMore && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" onClick={loadMore}>
              Load more duplicate groups
            </Button>
          </div>
        )}

        <div className="text-center text-xs text-muted-foreground">
          {groups.length} of {duplicates?.totalCount ?? 0} groups shown
        </div>
      </Card.Content>
    </Card>
  );
}
