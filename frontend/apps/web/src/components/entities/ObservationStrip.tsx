import { type ReactNode } from 'react';

import { GlobalUID } from '@ci/common';
import { Badge, cn } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { PendingImage } from '@/components/PendingImage';
import { gql, useFragment, type FragmentType } from '@/graphql';
import type { ObservationStripDataFragment } from '@/graphql/graphql';
import { humanizeEnum } from '@/lib/utils';

import { BoundingBoxOverlay } from './BoundingBoxOverlay';
import { resolveMediaUrl } from './resolveMediaUrl';

/**
 * One sighting of a physical thing: what the detector saw, where, how sure it
 * was, and whether a human has agreed with it yet.
 */
export const OBSERVATION_FRAGMENT = gql(`
  fragment ObservationStripData on ObjectObservationType {
    id
    label
    labelSource
    detector
    detectorVersion
    detectionConfidence
    resolutionConfidence
    resolutionMethod
    confirmedByUser
    observedAt
    sourceKind
    placeEntityId
    bbox {
      x
      y
      w
      h
    }
    # The crop (or, failing that, the whole frame) already resolved to URLs, and
    # the place already resolved to a name. Both used to be a per-tile useQuery
    # — 2 round-trips per sighting, 48 for a 24-tile review page, against an
    # ApolloProvider on a plain createHttpLink that batches nothing. They are
    # DataLoader-backed ResolveFields now (ObjectObservationResolver), so a
    # whole page of tiles costs one request.
    media {
      id
      mimetype
      previewUrl
      mediaUrl
      url
    }
    place {
      id
      name
    }
  }
`);

export type ObservationStripItem = FragmentType<typeof OBSERVATION_FRAGMENT>;

/** What a tile hands its action renderer — enough to act, without unmasking. */
export interface ObservationActionTarget {
  id: string;
  label: string;
}

function formatPercent(value?: number | null): string | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }

  return `${Math.round(value * 100)}%`;
}

function formatObservedAt(value?: string | Date | null): string | null {
  if (value == null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

/**
 * The place a sighting happened.
 *
 * `placeEntityId` still drives the link target rather than `place.id`: the
 * sighting knows where it was even when the place row itself is gone, and a
 * caption that reads "a place" and still navigates is better than one that
 * disappears.
 */
function ObservationPlaceLink({
  placeEntityId,
  place,
}: {
  placeEntityId: string;
  place: ObservationStripDataFragment['place'];
}) {
  return (
    <Link
      to={`/places/${GlobalUID.parse('place', placeEntityId)}`}
      className="truncate hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {place?.name || 'a place'}
    </Link>
  );
}

function ObservationThumbnail({
  media,
  bbox,
  label,
}: {
  media: ObservationStripDataFragment['media'];
  bbox: ObservationStripDataFragment['bbox'];
  label: string;
}) {
  const src =
    resolveMediaUrl(media?.previewUrl) ?? resolveMediaUrl(media?.mediaUrl) ?? resolveMediaUrl(media?.url);

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-md bg-muted">
      {src ? (
        <PendingImage src={src} />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
          No image
        </div>
      )}
      {/* Drawn even without a thumbnail: the box still says WHERE in the frame
          the detector looked, and hiding it would make an image-less sighting
          look like it had no detection at all. */}
      <BoundingBoxOverlay bbox={bbox} label={label} />
    </div>
  );
}

function ObservationTile({
  observation,
  actions,
}: {
  observation: ObservationStripDataFragment;
  actions?: (target: ObservationActionTarget) => ReactNode;
}) {
  const label = observation.label || 'Unlabelled sighting';
  const detection = formatPercent(observation.detectionConfidence);
  const resolution = formatPercent(observation.resolutionConfidence);
  const observedAt = formatObservedAt(observation.observedAt);

  return (
    <div className="flex w-40 shrink-0 flex-col gap-2 rounded-md border bg-card p-2">
      <ObservationThumbnail media={observation.media} bbox={observation.bbox} label={label} />

      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium" title={label}>
            {label}
          </span>
          {observation.confirmedByUser && <Badge variant="secondary">Confirmed</Badge>}
        </div>

        <div className="mt-0.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {observedAt && <span>{observedAt}</span>}
          {observation.placeEntityId && (
            <ObservationPlaceLink placeEntityId={observation.placeEntityId} place={observation.place} />
          )}
          {/* Two different confidences, and conflating them would be a lie: one
              is how sure the detector was it saw SOMETHING, the other how sure
              the resolution ladder was it was THIS thing. */}
          {(observation.detector || detection) && (
            <span className="truncate">
              {[humanizeEnum(observation.detector), detection && `${detection} sure`]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {resolution && (
            <span className="truncate">
              {[humanizeEnum(observation.resolutionMethod), `${resolution} match`]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
      </div>

      {actions?.({ id: observation.id, label })}
    </div>
  );
}

interface Props {
  observations: readonly ObservationStripItem[];
  /** Per-sighting actions (confirm / reject). Omit for a read-only strip. */
  actions?: (target: ObservationActionTarget) => ReactNode;
  /** Shown in place of the strip when there is nothing to show. */
  emptyMessage?: string;
  /**
   * Wrap onto multiple lines instead of scrolling sideways. A handful of
   * sightings ON one thing reads fine as a strip; a review QUEUE of them does
   * not — a horizontal scrollbar hides most of the work to be done.
   */
  wrap?: boolean;
}

/**
 * A row of sightings, each with the detector's box drawn over the frame it came
 * from.
 */
export function ObservationStrip({
  observations,
  actions,
  emptyMessage = 'No sightings yet',
  wrap = false,
}: Props) {
  const items = useFragment(OBSERVATION_FRAGMENT, observations);

  if (items.length === 0) {
    return <div className="py-2 text-sm text-muted-foreground">{emptyMessage}</div>;
  }

  return (
    <div className={cn('flex gap-3 pb-2', wrap ? 'flex-wrap' : 'overflow-x-auto')}>
      {items.map((observation) => (
        <ObservationTile key={observation.id} observation={observation} actions={actions} />
      ))}
    </div>
  );
}
