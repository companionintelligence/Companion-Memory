import { Card, Tooltip } from '@ci/shadcn';
import { Calendar, Clock, MapPin } from '@ci/shadcn/icons';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { useEntityService } from '../../useEntityService';
import { formatDateTime } from '../utils';

interface Props {
  entity: FragmentType<typeof EVENT_FRAGMENT>;
}

export const EVENT_FRAGMENT = gql(`
  fragment TimelineEventCardData on EventType {
    id
    title
    description
    startTime
    endTime
    location {
      ... on PlaceType {
        id
        name
        properties
      }
    }
  }
`);

export function EventCard({ entity }: Props) {
  const data = useFragment(EVENT_FRAGMENT, entity);
  const [, { setActiveEntity }] = useEntityService();
  const hasStartDate = data.startTime;
  const hasEndDate = data.endTime;
  // const hasOrganizer = data.organizer;
  // const hasRepeating = data.repeatingFrequency;
  // const hasDuration = data.duration;
  // const hasSource = data.source;
  // const hasSourceLink = data.sourceLink;
  const hasLocation = data.location?.name || data.location?.properties?.address;
  const hasDescription = data.description;

  return (
    <Card
      className="!gap-2 !py-4 px-6 cursor-pointer hover:shadow-lg transition-shadow duration-200"
      onClick={() => setActiveEntity({ ...data, __typename: 'EventType' })}
    >
      <div className="flex items-start gap-3">
        <Calendar className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--primary)]" />
        <div className="flex-1 min-w-0">
          <Tooltip>
            <Tooltip.Trigger asChild>
              <h3 className="text-lg font-semibold text-card-foreground truncate cursor-default">
                {data.title}
              </h3>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>{data.title}</p>
            </Tooltip.Content>
          </Tooltip>
          {/*<p className="text-sm text-muted-foreground">{data.category}</p>*/}
        </div>
      </div>

      {hasStartDate && (
        <div className="flex items-center gap-5">
          <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            {hasEndDate && <span className="text-sm font-medium text-muted-foreground">Start:</span>}
            <span className="ml-2 text-sm text-card-foreground">
              {formatDateTime(
                new Date(data.startTime).toDateString(),
                new Date(data.startTime).toTimeString(),
              )}
            </span>
          </div>
        </div>
      )}

      {hasEndDate && (
        <div className="flex items-center gap-5">
          <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">End:</span>
            <span className="ml-2 text-sm text-card-foreground">
              {formatDateTime(new Date(data.endTime).toDateString(), new Date(data.endTime).toTimeString())}
            </span>
          </div>
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
        <div className="flex items-center gap-5">
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
        <div className="pt-3 pb-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{data.description}</p>
        </div>
      )}
    </Card>
  );
}
