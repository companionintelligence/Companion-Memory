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

/**
 * The canonical timestamp for an entity, matching the server's ordering logic
 * (`SearchResolver.getEntityTimestamp`, which keys off `time ?? startTime`).
 * Keeping the same field priority here ensures the date-group headers we render
 * line up with the chronological order the API already returned. Entities with
 * no domain timestamp (people, places, concepts, …) return null and fall into
 * the trailing "No date" bucket.
 *
 * Reads the aliased `bucketTime`/`bucketStartTime` fields selected directly on
 * the search query's node so access is type-safe under fragment masking (rather
 * than casting through the masked spread fragments).
 */
export function getEntityTimestamp(entity: EntityItem): Date | null {
  let raw: unknown;

  switch (entity.__typename) {
    case 'CommunicationType':
    case 'BrowserActivityType':
      raw = entity.bucketTime;
      break;
    case 'EventType':
      raw = entity.bucketStartTime;
      break;
    default:
      return null;
  }

  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw;
  }

  if (typeof raw === 'string') {
    const date = new Date(raw);

    return isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/**
 * Compact event time for timeline cards: just the time range for a same-day
 * event ("8 AM – 5 PM"), a single time when there's no end, and short dates
 * only when the event spans multiple days. The surrounding date-group header
 * already carries the month/year context, so the card stays uncluttered.
 */
export function formatEventTimeRange(start: string, end?: string | null): string {
  const startDate = new Date(start);

  if (isNaN(startDate.getTime())) {
    return '';
  }

  const time = (d: Date) => {
    const opts: Intl.DateTimeFormatOptions = { hour: 'numeric' };

    if (d.getMinutes() !== 0) {
      opts.minute = '2-digit';
    }

    return d.toLocaleTimeString('en-US', opts);
  };

  const dateTime = (d: Date) =>
    `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time(d)}`;

  if (!end) {
    return time(startDate);
  }

  const endDate = new Date(end);

  if (isNaN(endDate.getTime())) {
    return time(startDate);
  }

  if (startDate.toDateString() === endDate.toDateString()) {
    return `${time(startDate)} – ${time(endDate)}`;
  }

  return `${dateTime(startDate)} – ${dateTime(endDate)}`;
}

const MEDIA_FILENAME_RE =
  /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|dng|raw|cr2|nef|mp4|mov|m4v|avi|mkv|webm|3gp|mpe?g|wmv)$/i;
const VIDEO_FILENAME_RE = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mpe?g|wmv)$/i;

/**
 * Reduce a reverse-geocoded street address to a compact "City, ST" so it can
 * sit inside an event title. Reverse geocoding yields full addresses like
 * "1642 Rambla Pacifico St, Malibu, CA 90265, USA"; we keep the locality and
 * the (zip-stripped) region. Best-effort — anything we can't parse confidently
 * is returned trimmed but otherwise untouched.
 */
function shortPlace(locationName?: string | null): string | null {
  const name = locationName?.trim();

  if (!name) {
    return null;
  }

  const parts = name
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return name.length <= 28 ? name : null;
  }

  const withoutCountry = /^(usa|united states|us)$/i.test(parts[parts.length - 1])
    ? parts.slice(0, -1)
    : parts;

  // The region chunk often carries a zip ("CA 90265") — drop the digits.
  const region = withoutCountry[withoutCountry.length - 1]?.replace(/\s*\d{4,}.*$/, '').trim();
  const city = withoutCountry.length >= 2 ? withoutCountry[withoutCountry.length - 2] : withoutCountry[0];

  const result = [city, region].filter(Boolean).join(', ');

  return result.length > 0 && result.length <= 28 ? result : null;
}

/**
 * A human-readable title for an event. Imported photo/video events arrive titled
 * with their raw filename or an opaque id ("DSC00838.jpg", "IMG_0301.MP4",
 * "50231557_2415233981880"); when that's all we have, derive a readable
 * "Photo · Malibu, CA · Jun 17, 2026" from the capture time and resolved place.
 * An authored title (an LLM caption, a calendar summary — anything with
 * whitespace that isn't a bare filename) is always preferred and passed through.
 */
export function eventDisplayTitle(input: {
  title?: string | null;
  startTime?: string | Date | null;
  locationName?: string | null;
  mediaContentType?: string | null;
}): string {
  const title = input.title?.trim() ?? '';
  const isMediaEvent =
    input.mediaContentType?.startsWith('image/') === true ||
    input.mediaContentType?.startsWith('video/') === true ||
    MEDIA_FILENAME_RE.test(title);

  // Keep a genuinely authored title (has spaces and isn't a filename), and keep
  // any title at all for non-media events — only media events get the rewrite.
  const looksAuthored = /\s/.test(title) && !MEDIA_FILENAME_RE.test(title);

  if (title && (looksAuthored || !isMediaEvent)) {
    return title;
  }

  const isVideo = input.mediaContentType?.startsWith('video/') === true || VIDEO_FILENAME_RE.test(title);
  const noun = isVideo ? 'Video' : 'Photo';

  const place = shortPlace(input.locationName);

  const date = input.startTime ? new Date(input.startTime) : null;
  const datePart =
    date && !isNaN(date.getTime())
      ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : null;

  const derived = [noun, place, datePart].filter((part): part is string => Boolean(part)).join(' · ');

  // Fall back to the raw title if we somehow derived nothing (no date, no place).
  return derived || title || noun;
}

interface DateBucket {
  key: string;
  label: string;
}

/** Coarse, human-friendly bucket for a date: Today / Yesterday / This Week / This Month / "Month Year". */
export function getDateBucket(date: Date, now: Date = new Date()): DateBucket {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay()); // back to Sunday
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const day = startOfDay(date).getTime();

  if (day >= today.getTime()) {
    return { key: 'today', label: 'Today' };
  }

  if (day >= yesterday.getTime()) {
    return { key: 'yesterday', label: 'Yesterday' };
  }

  if (day >= weekStart.getTime()) {
    return { key: 'week', label: 'This Week' };
  }

  if (day >= monthStart.getTime()) {
    return { key: 'month', label: 'This Month' };
  }

  return {
    key: `${date.getFullYear()}-${date.getMonth()}`,
    label: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  };
}

export interface EntityDateGroup {
  /**
   * Unique React key: the bucket id plus the group's ordinal. The ordinal keeps
   * keys distinct even if a bucket recurs non-contiguously (which can happen
   * under a relevance/name sort), avoiding duplicate-key collisions.
   */
  key: string;
  /** Coarse bucket id used to merge adjacent entities of the same day-bucket. */
  bucket: string;
  label: string;
  entities: EntityItem[];
}

/**
 * Whether the active sort keeps results in date order, so contiguous date-group
 * headers stay meaningful. Explicit time sorts are chronological; relevance and
 * name sorts interleave dates, so the contiguous grouping below would emit
 * repeated, out-of-order headers — callers render a flat, header-less list then.
 *
 * The "Default" (no explicit sort) case depends on whether a free-text query is
 * active: the server orders by relevance when one is present and by time
 * otherwise (SearchResolver: `candidateSource === 'query' ? 'relevance' :
 * 'time'`). Pass `hasQuery` so we only group when the data is actually
 * time-ordered. Mirrors the `sortBy` values from the toolbar's SORT_OPTIONS.
 */
export function isChronologicalSort(sortBy: string | null | undefined, hasQuery = false): boolean {
  if (sortBy === 'time') {
    return true;
  }

  if (sortBy === 'relevance' || sortBy === 'name') {
    return false;
  }

  return !hasQuery;
}

/**
 * Segment an already-ordered list of entities into contiguous date groups,
 * preserving the incoming (server-provided) order rather than re-sorting. A new
 * group starts whenever the bucket changes, so appended pages merge seamlessly
 * into the trailing group. Used by both List and Timeline for a consistent
 * Today / Yesterday / This Week / … layout.
 *
 * Only meaningful when the results are in chronological order (see
 * {@link isChronologicalSort}); under a relevance/name sort a bucket can recur
 * non-contiguously, so each group carries a unique `key` (bucket + ordinal)
 * distinct from the `bucket` used to merge adjacent same-day entities.
 */
export function groupEntitiesByBucket(entities: EntityItem[], now: Date = new Date()): EntityDateGroup[] {
  const groups: EntityDateGroup[] = [];

  for (const entity of entities) {
    const timestamp = getEntityTimestamp(entity);
    const { key: bucket, label } = timestamp
      ? getDateBucket(timestamp, now)
      : { key: 'undated', label: 'No date' };

    const current = groups[groups.length - 1];

    if (current && current.bucket === bucket) {
      current.entities.push(entity);
    } else {
      groups.push({ key: `${bucket}-${groups.length}`, bucket, label, entities: [entity] });
    }
  }

  return groups;
}

/** Compact per-row timestamp: time-of-day for today, "Mon D" this year, otherwise "Mon D, YYYY". */
export function formatRowTime(date: Date | null, now: Date = new Date()): string {
  if (!date) {
    return '';
  }

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
