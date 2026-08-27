import { Card, Tooltip } from '@ci/shadcn';
import { Calendar, Clock, MapPin, Play } from '@ci/shadcn/icons';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { useEntityService } from '../../useEntityService';
import { resolveStaticUrl } from '../EntityDetails/EntityDetailScaffold';
import { eventDisplayTitle, formatEventTimeRange } from '../utils';

// Mirrors the backend's TIME_SOURCES.INGEST (pipeline/stages/clean/
// TemporalRepairStage) and the copy of the same string in Components/utils.tsx
// getEntityTimestamp — see the note there on why this is a literal rather than
// a shared import. startTime is NOT NULL, so an ingest-sourced event (a Google
// Maps saved place, a Reddit affiliation, …) still carries a value here; it is
// the import wall clock, not a real date, and must not render as one.
const INGEST_TIME_SOURCE = 'ingest';

interface Props {
  entity: FragmentType<typeof EVENT_FRAGMENT>;
}

export const EVENT_FRAGMENT = gql(`
  fragment TimelineEventCardData on EventType {
    id
    title
    description
    sourceSystem
    # The connector's catch-all for what has no column — for a social.like
    # event that is the liked Page's URL, which the drawer offers as a link.
    metadata
    startTime
    endTime
    timeSource
    locationName
    location {
      ... on PlaceType {
        id
        name
        properties
      }
    }
    previewUrl
    mediaUrl
    mediaContentType
    mediaWidth
    mediaHeight
    mediaSize
    tags {
      label
    }
    # What the event is about, for events that ARE a watch/listen/read: the
    # first linked content rows, with their resolved preview and player.
    contents(first: 3) {
      edges {
        node {
          id
          title
          contentUrl: url
          ...RichMediaData
        }
      }
    }
  }
`);

export function EventCard({ entity }: Props) {
  const data = useFragment(EVENT_FRAGMENT, entity);
  const [, { setActiveEntity }] = useEntityService();
  // startTime is NOT NULL, so this is always truthy — but for an
  // ingest-sourced record (see INGEST_TIME_SOURCE above) it is the import
  // wall clock standing in for a date the source never gave, and rendering it
  // as a specific time is exactly the fabrication this card must not repeat.
  const isUndated = data.timeSource === INGEST_TIME_SOURCE;
  const hasStartDate = Boolean(data.startTime);
  const title = eventDisplayTitle({
    title: data.title,
    // Withheld when undated so a media event with no real capture time never
    // derives a "Photo · place · Aug 21, 2026" caption off the import clock.
    startTime: isUndated ? null : data.startTime,
    locationName: data.locationName ?? data.location?.name,
    mediaContentType: data.mediaContentType,
  });
  const thumbUrl = resolveStaticUrl(data.previewUrl);
  const isVideo = data.mediaContentType?.startsWith('video/') ?? false;
  // const hasOrganizer = data.organizer;
  // const hasRepeating = data.repeatingFrequency;
  // const hasDuration = data.duration;
  // const hasSource = data.source;
  // const hasSourceLink = data.sourceLink;
  const hasLocation = data.location?.name || data.location?.properties?.address;
  const hasDescription = data.description;

  return (
    <Card
      className="!gap-2 !px-6 !py-4 cursor-pointer transition-shadow duration-200 hover:shadow-lg"
      onClick={() => setActiveEntity({ ...data, __typename: 'EventType', bucketStartTime: data.startTime })}
    >
      {thumbUrl && (
        <div className="relative -mx-2 mb-1 overflow-hidden rounded-md bg-muted">
          <img src={thumbUrl} alt={title} loading="lazy" className="h-44 w-full object-cover" />
          {isVideo && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-black/55 text-white">
                <Play className="size-5 translate-x-0.5 fill-current" />
              </span>
            </span>
          )}
        </div>
      )}

      <div className="flex items-start gap-3">
        {!thumbUrl && <Calendar className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--primary)]" />}
        <div className="flex-1 min-w-0">
          <Tooltip>
            <Tooltip.Trigger asChild>
              <h3 className="truncate text-lg font-semibold leading-4 text-card-foreground cursor-default">
                {title || 'Untitled event'}
              </h3>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>{title || 'Untitled event'}</p>
            </Tooltip.Content>
          </Tooltip>
          {/*<p className="text-sm text-muted-foreground">{data.category}</p>*/}
        </div>
      </div>

      {hasStartDate && (
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          {isUndated ? (
            // The source gave this record no time at all — startTime is only
            // the import wall clock (toEventInput stamps time_source =
            // 'ingest' for exactly this case). Saying so beats a specific,
            // fabricated-looking time a reader would reasonably trust.
            <span className="text-sm italic text-muted-foreground">Date unknown</span>
          ) : (
            <span className="text-sm tabular-nums text-card-foreground">
              {formatEventTimeRange(data.startTime, data.endTime)}
            </span>
          )}
        </div>
      )}

      {/*{hasOrganizer && (*/}
      {/*  <div className="flex items-center gap-5">*/}
      {/*    <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />*/}
      {/*    <div className="min-w-0">*/}
      {/*      <span className="text-sm font-medium text-muted-foreground">Organizer:</span>*/}
      {/*      <span className="ml-2 text-sm text-card-foreground">{data.organizer}</span>*/}
      {/*    </div>*/}
      {/*  </div>*/}
      {/*)}*/}

      {/*{hasRepeating && (*/}
      {/*  <div className="flex items-center gap-5">*/}
      {/*    <Repeat className="h-4 w-4 text-muted-foreground flex-shrink-0" />*/}
      {/*    <div className="min-w-0">*/}
      {/*      <span className="text-sm font-medium text-muted-foreground">Repeats:</span>*/}
      {/*      <span className="ml-2 text-sm text-card-foreground">{data.repeatingFrequency}</span>*/}
      {/*    </div>*/}
      {/*  </div>*/}
      {/*)}*/}

      {/*{hasDuration && (*/}
      {/*  <div className="flex items-center gap-5">*/}
      {/*    <Timer className="h-4 w-4 text-muted-foreground flex-shrink-0" />*/}
      {/*    <div className="min-w-0">*/}
      {/*      <span className="text-sm font-medium text-muted-foreground">Duration:</span>*/}
      {/*      <span className="ml-2 text-sm text-card-foreground">{formatDuration(data.duration || 0)}</span>*/}
      {/*    </div>*/}
      {/*  </div>*/}
      {/*)}*/}

      {hasLocation && (
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">Location:</span>
            <span className="ml-2 text-sm text-card-foreground">{hasLocation}</span>
          </div>
        </div>
      )}

      {/*{hasSource && (*/}
      {/*  <div className="flex items-center gap-5">*/}
      {/*    <span className="text-sm font-medium text-muted-foreground">Source:</span>*/}
      {/*    <span className="text-sm text-card-foreground">{data.source}</span>*/}
      {/*  </div>*/}
      {/*)}*/}

      {/*{hasSourceLink && (*/}
      {/*  <div className="flex items-center gap-5">*/}
      {/*    <Link className="h-4 w-4 text-muted-foreground flex-shrink-0" />*/}
      {/*    <div className="min-w-0">*/}
      {/*      <a*/}
      {/*        href={data.sourceLink}*/}
      {/*        target="_blank"*/}
      {/*        rel="noopener noreferrer"*/}
      {/*        className="text-sm text-primary hover:text-primary/80 underline"*/}
      {/*        onClick={(e) => e.stopPropagation()}*/}
      {/*      >*/}
      {/*        View source*/}
      {/*      </a>*/}
      {/*    </div>*/}
      {/*  </div>*/}
      {/*)}*/}

      {hasDescription && (
        <div className="pt-2">
          <p className="text-sm text-muted-foreground leading-relaxed">{data.description}</p>
        </div>
      )}
    </Card>
  );
}
