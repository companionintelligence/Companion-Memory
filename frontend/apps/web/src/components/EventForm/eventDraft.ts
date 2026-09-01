/**
 * The editing shape behind {@link EventForm}.
 *
 * Every field is a plain string (or boolean) — a form's natural state — and the
 * conversion to the GraphQL `CreateEventInput` lives here rather than in the
 * modal, so the date/time assembly and the blank-field rules are testable on
 * their own and can't drift between callers.
 *
 * Date and clock time are held apart rather than as one `datetime-local`
 * string: an all-day event has a date and no clock time, and toggling all-day
 * on a combined value would have to reformat it (and lose the time the user
 * already typed if they toggled back).
 */

export interface EventDraft {
  title: string;
  description: string;
  /** yyyy-mm-dd, as produced by <input type="date">. */
  startDate: string;
  /** HH:mm, as produced by <input type="time">. Ignored when `isAllDay`. */
  startClock: string;
  endDate: string;
  endClock: string;
  isAllDay: boolean;
  eventType: string;
  category: string;
  locationName: string;
  /** Decimal degrees, as typed. Blank unless the user fills both. */
  latitude: string;
  longitude: string;
}

/** Local-time `yyyy-mm-dd` for a Date — `toISOString` would shift the day in a negative-offset zone. */
function toDateInputValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local-time `HH:mm` for a Date. */
function toClockInputValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * A blank event, dated now and rounded up to the next quarter hour — the same
 * courtesy a calendar's "new event" does, so the common case is two fields
 * (title, maybe duration) rather than a date picker every time.
 */
export function emptyEventDraft(now: Date = new Date()): EventDraft {
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15);

  const end = new Date(start.getTime() + 60 * 60 * 1000);

  return {
    title: '',
    description: '',
    startDate: toDateInputValue(start),
    startClock: toClockInputValue(start),
    endDate: toDateInputValue(end),
    endClock: toClockInputValue(end),
    isAllDay: false,
    eventType: '',
    category: '',
    locationName: '',
    latitude: '',
    longitude: '',
  };
}

/**
 * Combine a date field and a clock field into a local-time Date. All-day
 * events start at local midnight; a missing clock on a timed event does the
 * same rather than refusing the date the user did give.
 */
export function combineDateAndClock(date: string, clock: string, allDay: boolean): Date | null {
  if (date.trim() === '') {
    return null;
  }

  const [year, month, day] = date.split('-').map(Number);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  let hours = 0;
  let minutes = 0;

  if (!allDay && clock.trim() !== '') {
    const [rawHours, rawMinutes] = clock.split(':').map(Number);

    if (Number.isFinite(rawHours) && Number.isFinite(rawMinutes)) {
      hours = rawHours;
      minutes = rawMinutes;
    }
  }

  const combined = new Date(year, month - 1, day, hours, minutes, 0, 0);

  return Number.isNaN(combined.getTime()) ? null : combined;
}

/** The GeoJSON Point `locationCoordinates` wants, or null unless BOTH parts parse. */
export function pointFromLatLng(
  latitude: string,
  longitude: string,
): { type: 'Point'; coordinates: [number, number] } | null {
  if (latitude.trim() === '' || longitude.trim() === '') {
    return null;
  }

  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  // PostGIS/GeoJSON order is [longitude, latitude] — not the order they are typed.
  return { type: 'Point', coordinates: [lng, lat] };
}

export type EventDraftProblem = 'title' | 'startDate' | 'endBeforeStart' | 'coordinates';

/**
 * What stops this draft from being saved, in the order the fields are shown.
 * Returns null when the draft is good.
 */
export function validateEventDraft(draft: EventDraft): EventDraftProblem | null {
  if (draft.title.trim() === '') {
    return 'title';
  }

  const start = combineDateAndClock(draft.startDate, draft.startClock, draft.isAllDay);

  if (start == null) {
    return 'startDate';
  }

  const end = combineDateAndClock(draft.endDate, draft.endClock, draft.isAllDay);

  if (end != null && end.getTime() < start.getTime()) {
    return 'endBeforeStart';
  }

  // A half-filled or out-of-range coordinate pair would be silently dropped by
  // pointFromLatLng, which reads as "the map lost my event" — say so instead.
  const hasSomeCoordinate = draft.latitude.trim() !== '' || draft.longitude.trim() !== '';

  if (hasSomeCoordinate && pointFromLatLng(draft.latitude, draft.longitude) == null) {
    return 'coordinates';
  }

  return null;
}

/**
 * The `CreateEventInput` for a draft. Blank optional fields are omitted rather
 * than sent as empty strings: this is a create, and an empty string would be
 * stored as an empty string (an event whose category is "" is not an event
 * with no category).
 *
 * `eventType` is deliberately left unset when blank. CalendarEventService.findInRange
 * serves the Schedule from a fixed set of calendar event types PLUS rows with
 * a NULL event_type, and unset is how user-created events land on the calendar.
 *
 * Throws when the draft is invalid — callers check {@link validateEventDraft}
 * first and render the message.
 */
export function eventDraftToInput(draft: EventDraft) {
  const start = combineDateAndClock(draft.startDate, draft.startClock, draft.isAllDay);

  if (start == null) {
    throw new Error('An event needs a start date');
  }

  const end = combineDateAndClock(draft.endDate, draft.endClock, draft.isAllDay);
  const point = pointFromLatLng(draft.latitude, draft.longitude);

  const optional = (value: string) => {
    const trimmed = value.trim();

    return trimmed === '' ? undefined : trimmed;
  };

  return {
    title: draft.title.trim(),
    description: optional(draft.description),
    startTime: start.toISOString(),
    endTime: end ? end.toISOString() : undefined,
    isAllDay: draft.isAllDay,
    durationMinutes: end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000)) : undefined,
    eventType: optional(draft.eventType),
    category: optional(draft.category),
    locationName: optional(draft.locationName),
    locationCoordinates: point ?? undefined,
  };
}
