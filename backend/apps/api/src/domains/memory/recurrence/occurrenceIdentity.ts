import { v5 as uuidv5 } from 'uuid';

/**
 * Fixed namespace for synthetic occurrence ids. Hardcoded, never generated:
 * the whole point of a v5 id is that the same occurrence gets the same id on
 * every read, on every box, forever, so that Apollo's cache, a React key and a
 * drag handler all agree about which chip is which.
 */
export const OCCURRENCE_NAMESPACE = '6d0e2d4a-1f83-4a1e-9c0d-3c7a1f5b8e42';

/**
 * The id an expanded occurrence carries — a uuidv5 of `<masterId>:<instant>`.
 *
 * ═══ WHY NOT THE OBVIOUS `<uuid>@<instant>` ═══
 * Because `ci.events.event_id` is a real `uuid` column and half the read path
 * says so in SQL. `ContentService.findByEventIds` batches with
 * `WHERE c.event_id = ANY($1::uuid[])`, so one composite id in a page of
 * events fails the whole statement with `invalid input syntax for type uuid`
 * and takes the entire `eventsInRange` GraphQL response down with it — not one
 * field of one node. `:` is worse still: `GlobalUID.decode` splits on it and
 * keeps `[1]`, so the id silently truncates instead of failing.
 *
 * A v5 uuid is syntactically a uuid, so every uuid-typed consumer in the tree
 * — the two DataLoaders, GlobalUID, Postgres itself, and whatever is added
 * next — keeps working without knowing occurrences exist.
 */
export function occurrenceEventId(masterId: string, recurrenceInstant: string): string {
  return uuidv5(`${masterId}:${recurrenceInstant}`, OCCURRENCE_NAMESPACE);
}

/**
 * The series UID inside a calendar `source_id`.
 *
 * A master's id is the bare iCalUID; an override's is `<uid>#<RECURRENCE-ID>`
 * (memory/identity/calendar.ts). This splits at the FIRST `#`, the same reading
 * `calendarEventIdentity` composes with — a UID containing a `#` is already
 * ambiguous under that scheme, and inventing a second, different reading here
 * would make the suppression key disagree with the id the override syncs under,
 * which is the one thing that must never happen.
 */
export function seriesUidOf(sourceId: string | null): string | null {
  const value = sourceId?.trim();

  if (!value) {
    return null;
  }

  const hash = value.indexOf('#');

  return hash === -1 ? value : value.slice(0, hash);
}
