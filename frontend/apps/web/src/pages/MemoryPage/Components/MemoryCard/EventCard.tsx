import { Card, Tooltip } from '@ci/shadcn';
import { Calendar, Clock, User, MapPin, Link, Repeat, Timer } from '@ci/shadcn/icons';

import type { MemoryItem } from '../../types';
import { useMemoryService } from '../../useMemoryService';
import { formatDateTime, formatDuration } from '../utils';

interface Props {
  memory: MemoryItem;
}

export function EventCard({ memory }: Props) {
  const { setActiveMemory } = useMemoryService();
  const hasStartDate = memory.startDate;
  const hasEndDate = memory.endDate;
  const hasOrganizer = memory.organizer;
  const hasRepeating = memory.repeatingFrequency;
  const hasDuration = memory.duration;
  const hasSource = memory.source;
  const hasSourceLink = memory.sourceLink;
  const hasLocation = memory.location?.name || memory.location?.address;
  const hasDescription = memory.description;

  const handleClick = () => {
    setActiveMemory(memory);
  };

  return (
    <Card
      className="!gap-2 !py-4 px-6 cursor-pointer hover:shadow-lg transition-shadow duration-200"
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        <Calendar className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--primary)]" />
        <div className="flex-1 min-w-0">
          <Tooltip>
            <Tooltip.Trigger asChild>
              <h3 className="text-lg font-semibold text-card-foreground truncate cursor-default">
                {memory.title}
              </h3>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>{memory.title}</p>
            </Tooltip.Content>
          </Tooltip>
          <p className="text-sm text-muted-foreground">{memory.category}</p>
        </div>
      </div>

      {hasStartDate && (
        <div className="flex items-center gap-5">
          <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">Start:</span>
            <span className="ml-2 text-sm text-card-foreground">
              {formatDateTime(memory.startDate || '', memory.startTime || undefined)}
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
              {formatDateTime(memory.endDate || '', memory.endTime || undefined)}
            </span>
          </div>
        </div>
      )}

      {hasOrganizer && (
        <div className="flex items-center gap-5">
          <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">Organizer:</span>
            <span className="ml-2 text-sm text-card-foreground">{memory.organizer}</span>
          </div>
        </div>
      )}

      {hasRepeating && (
        <div className="flex items-center gap-5">
          <Repeat className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">Repeats:</span>
            <span className="ml-2 text-sm text-card-foreground">{memory.repeatingFrequency}</span>
          </div>
        </div>
      )}

      {hasDuration && (
        <div className="flex items-center gap-5">
          <Timer className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">Duration:</span>
            <span className="ml-2 text-sm text-card-foreground">{formatDuration(memory.duration || 0)}</span>
          </div>
        </div>
      )}

      {hasLocation && (
        <div className="flex items-center gap-5">
          <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">Location:</span>
            <span className="ml-2 text-sm text-card-foreground">{hasLocation}</span>
          </div>
        </div>
      )}

      {hasSource && (
        <div className="flex items-center gap-5">
          <span className="text-sm font-medium text-muted-foreground">Source:</span>
          <span className="text-sm text-card-foreground">{memory.source}</span>
        </div>
      )}

      {hasSourceLink && (
        <div className="flex items-center gap-5">
          <Link className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <a
              href={memory.sourceLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:text-primary/80 underline"
              onClick={(e) => e.stopPropagation()}
            >
              View source
            </a>
          </div>
        </div>
      )}

      {hasDescription && (
        <div className="pt-3 pb-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{memory.description}</p>
        </div>
      )}
    </Card>
  );
}
