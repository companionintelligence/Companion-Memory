import { Calendar, User, MapPin, Package, FileText, Contact, Lightbulb, Target } from '@ci/shadcn/icons';

import type { EntityItem } from '../../MemoryPage/useEntityService';

export function formatDuration(minutes: number): string {
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const mins = minutes % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  }

  if (hours > 0) {
    parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  }

  if (mins > 0) {
    parts.push(`${mins} minute${mins !== 1 ? 's' : ''}`);
  }

  return parts.join(', ');
}

export function formatDateTime(dateStr: string, timeStr?: string): string {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return dateStr;
    }

    if (timeStr) {
      const [hours, minutes] = timeStr.split(':');
      const dateTime = new Date(date);
      dateTime.setHours(parseInt(hours, 10), parseInt(minutes, 10));

      return dateTime.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export function formatDateForDisplay(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00');
  if (isNaN(date.getTime())) {
    return dateStr;
  }

  // Compare using local dates to match user's timezone
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const entityDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (entityDate.getTime() === today.getTime()) {
    return 'Today';
  }

  if (entityDate.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }

  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function sortEntitiesByTime(entities: EntityItem[][]): EntityItem[][] {
  return [...entities].sort((a, b) => {
    const dateA =
      'time' in a
        ? new Date(a.time as string)
        : 'startTime' in a
          ? new Date(a.startTime as string)
          : new Date();
    const dateB =
      'time' in b
        ? new Date(b.time as string)
        : 'startTime' in b
          ? new Date(b.startTime as string)
          : new Date();
    if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
      return 0;
    }

    return dateA.getTime() - dateB.getTime();
  });
}

export function groupEntitiesByDate(entities: EntityItem[]): Array<{
  date: string;
  entities: EntityItem[];
}> {
  const groups: Record<string, EntityItem[]> = {};

  entities.forEach((entity) => {
    if (!('time' in entity) && !('startTime' in entity)) {
      return;
    }

    const entityDate =
      'time' in entity
        ? new Date(entity.time as string)
        : 'startTime' in entity
          ? new Date(entity.startTime as string)
          : new Date();
    if (!isNaN(entityDate.getTime())) {
      // Use local date instead of UTC to match user's timezone
      const year = entityDate.getFullYear();
      const month = String(entityDate.getMonth() + 1).padStart(2, '0');
      const day = String(entityDate.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;

      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }

      groups[dateKey].push(entity);
    }
  });

  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entities]) => ({ date, entities }));
}

export function getEntityTypeIcon(type: string) {
  switch (type.toLowerCase()) {
    case 'person':
      return <User className="h-4 w-4" />;
    case 'event':
      return <Calendar className="h-4 w-4" />;
    case 'place':
    case 'location':
      return <MapPin className="h-4 w-4" />;
    case 'thing':
    case 'object':
      return <Package className="h-4 w-4" />;
    case 'content':
      return <FileText className="h-4 w-4" />;
    case 'contact':
      return <Contact className="h-4 w-4" />;
    case 'concept':
      return <Lightbulb className="h-4 w-4" />;
    default:
      return <Target className="h-4 w-4" />;
  }
}

// Got from the top answer here: https://stackoverflow.com/questions/15900485/correct-way-to-convert-size-in-bytes-to-kb-mb-gb-in-javascript
export function formatBytes(bytes: number | string, decimals = 2) {
  if (typeof bytes === 'string') {
    bytes = parseInt(bytes);
  }

  if (!+bytes) {
    return '0 Bytes';
  }

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
