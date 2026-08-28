import { useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { Button, Card, Dialog, Input } from '@ci/shadcn';

import { ObservationStrip } from '@/components/entities';
import { gql } from '@/graphql';

/** Sightings per page. Offset-based: `unresolvedObservations` has no cursor. */
export const REVIEW_PAGE_SIZE = 24;

// The four documents are exported so tests can mock the exact operations this
// component sends, rather than a re-declared copy that could drift from them.
export const GET_UNRESOLVED_OBSERVATIONS = gql(`
  query GetUnresolvedObservations($limit: Int, $offset: Int) {
    unresolvedObservations(limit: $limit, offset: $offset) {
      ...ObservationStripData
    }
  }
`);

// The picker's candidate list. Deliberately the plain `items` browse rather
// than full search: the answer to "which of my things is this" is always
// something already owned.
export const SEARCH_THINGS = gql(`
  query SearchThingsForObservation($query: String) {
    items(query: $query, first: 8, sort: RECENTLY_SEEN) {
      edges {
        node {
          id
          name
          brand
          model
          category
        }
      }
    }
  }
`);

export const CONFIRM_OBSERVATION = gql(`
  mutation ConfirmUnresolvedObservation($id: ID!, $itemId: ID) {
    confirmObservation(id: $id, itemId: $itemId) {
      id
      confirmedByUser
      resolvedObjectId
      resolutionMethod
      resolutionConfidence
    }
  }
`);

export const REJECT_OBSERVATION = gql(`
  mutation RejectUnresolvedObservation($id: ID!) {
    rejectObservation(id: $id) {
      id
      confirmedByUser
      resolvedObjectId
      resolutionMethod
      resolutionConfidence
    }
  }
`);

/**
 * Pick which owned thing a sighting is of.
 *
 * A dialog rather than an inline control on the tile: the tile is 160px wide,
 * and a search field plus results does not fit in one without shrinking the
 * picture the decision is being made from.
 */
function ThingPickerDialog({
  observation,
  onClose,
  onPicked,
}: {
  observation: { id: string; label: string } | null;
  onClose: () => void;
  onPicked: (itemId: string) => Promise<unknown>;
}) {
  // Seeded from the detector's own label — usually the right search already.
  const [query, setQuery] = useState('');

  const { data, loading } = useQuery(SEARCH_THINGS, {
    variables: { query: query.trim() === '' ? (observation?.label ?? null) : query.trim() },
    skip: observation == null,
  });

  const candidates = data?.items.edges.map((edge) => edge.node) ?? [];

  return (
    <Dialog
      open={observation != null}
      onOpenChange={(open) => {
        if (!open) {
          setQuery('');
          onClose();
        }
      }}
    >
      <Dialog.Content className="sm:max-w-[520px]">
        <Dialog.Header>
          <Dialog.Title>Which thing is this?</Dialog.Title>
          <Dialog.Description>
            {observation
              ? `The detector labelled it "${observation.label}". Pick the thing you already own.`
              : ''}
          </Dialog.Description>
        </Dialog.Header>

        <Input
          aria-label="Search your things"
          placeholder="Search your things"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {loading && candidates.length === 0 && (
            <div className="py-2 text-sm text-muted-foreground">Searching…</div>
          )}

          {!loading && candidates.length === 0 && (
            <div className="py-2 text-sm text-muted-foreground">Nothing you own matches that.</div>
          )}

          {candidates.map((thing) => (
            <button
              key={thing.id}
              type="button"
              className="flex w-full flex-col rounded-md border p-2 text-left transition hover:bg-accent"
              onClick={async () => {
                await onPicked(thing.id);
                setQuery('');
                onClose();
              }}
            >
              <span className="truncate font-medium">{thing.name || 'Unnamed thing'}</span>
              <span className="truncate text-sm text-muted-foreground">
                {[thing.brand, thing.model, thing.category].filter(Boolean).join(' · ') || 'No details'}
              </span>
            </button>
          ))}
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

/**
 * The queue of sightings the resolution ladder could not tie to an owned thing.
 *
 * Two answers only, and they are the two the backend has mutations for:
 * `confirmObservation` (this is that thing) and `rejectObservation` (not a
 * thing I own). Anything else would be a control with nothing behind it.
 */
export function ObservationReview({ onResolved }: { onResolved?: () => Promise<unknown> | void }) {
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, loading, error: loadError, refetch } = useQuery(GET_UNRESOLVED_OBSERVATIONS, {
    variables: { limit: REVIEW_PAGE_SIZE, offset: page * REVIEW_PAGE_SIZE },
    notifyOnNetworkStatusChange: true,
  });

  const [confirmObservation] = useMutation(CONFIRM_OBSERVATION);
  const [rejectObservation, { loading: rejecting }] = useMutation(REJECT_OBSERVATION);

  const observations = data?.unresolvedObservations ?? [];

  // A resolved sighting leaves this queue, so both lists have to be re-read:
  // this one, and whatever browse the parent is showing (a confirmation moves
  // the thing's last-seen date).
  const afterResolve = async () => {
    await Promise.all([refetch(), onResolved?.()]);
  };

  const reject = async (id: string) => {
    setError(null);

    try {
      await rejectObservation({ variables: { id } });
      await afterResolve();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record that.');
    }
  };

  const confirm = async (observationId: string, itemId: string) => {
    setError(null);

    try {
      await confirmObservation({ variables: { id: observationId, itemId } });
      await afterResolve();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record that.');
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">Unresolved sightings</Card.Title>
        <Card.Description>
          Things a detector saw but could not match to anything you own. Tell it which thing it was, or that
          it was not one of yours.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        {loading && observations.length === 0 ? (
          <div className="py-2 text-sm text-muted-foreground">Loading sightings…</div>
        ) : loadError && observations.length === 0 ? (
          // A failed query used to fall through to the strip with an empty list
          // and print "Nothing is waiting for review." — the one message that
          // tells the owner everything is fine and there is nothing to come
          // back for, on the surface whose whole job is to collect detections a
          // human still has to resolve. The mutations below were already
          // guarded; only the read was not.
          <div className="flex flex-col items-start gap-2 py-2">
            <span className="text-sm text-destructive">Could not load sightings.</span>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <ObservationStrip
            wrap
            observations={observations}
            emptyMessage="Nothing is waiting for review."
            actions={(target) => (
              <div className="flex flex-col gap-1">
                <Button size="sm" variant="secondary" disabled={rejecting} onClick={() => setPending(target)}>
                  This is…
                </Button>
                <Button size="sm" variant="ghost" disabled={rejecting} onClick={() => void reject(target.id)}>
                  Not a thing
                </Button>
              </div>
            )}
          />
        )}

        {error && <div className="text-sm text-destructive">{error}</div>}

        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1}</span>
          <Button
            variant="outline"
            size="sm"
            // `unresolvedObservations` returns a bare list with no total, so a
            // short page is the only end-of-queue signal there is.
            disabled={observations.length < REVIEW_PAGE_SIZE}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </Card.Content>

      <ThingPickerDialog
        observation={pending}
        onClose={() => setPending(null)}
        onPicked={(itemId) => confirm(pending!.id, itemId)}
      />
    </Card>
  );
}
