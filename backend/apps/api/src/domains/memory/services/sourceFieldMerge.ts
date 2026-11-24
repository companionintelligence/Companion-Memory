/**
 * The time and title refresh for events a source owns, as pure functions — the
 * same three-way merge `sourceStatusMerge.ts` applies to `status`, for the two
 * other fields a source re-delivers when it changes them.
 *
 * A calendar connection re-delivers a meeting when its organizer moves or
 * renames it. The stored row cannot simply take the new values, because they
 * are also the user's: `update` writes the title and the time, and `reschedule`
 * moves the time (marking a synced row `external_sync_status = 'pending'`). A
 * meeting the user moved must stay where the user put it when the organizer
 * edits its agenda. So each field keeps beside it the value its SOURCE
 * delivered last time — its merge base — and a re-delivery is a three-way
 * merge:
 *
 *  - the row still shows the base → nobody else touched it, and the source's
 *    new value lands;
 *  - the row shows anything else → someone else changed it, and that stands;
 *  - either way the new value becomes the base, so once the row and the source
 *    agree again, the source's later changes flow through.
 *
 * ── Where the bases live: typed columns, not one jsonb snapshot ─────────────
 *
 * `ci.events.source_start_time`, `source_end_time`, `source_recurrence` and
 * `source_title` (20261001154235), beside #2890's `source_status`. One jsonb
 * snapshot would hold them all in one column and take new fields without a
 * migration, but:
 *
 *  - A base is only useful if it compares EXACTLY with the value it shadows.
 *    `timestamptz` against `timestamptz` does. A timestamp inside jsonb is a
 *    string, and the app and SQL spell the same instant differently
 *    (`…T19:00:00.000Z` from `JSON.stringify`, `…T19:00:00+00:00` from
 *    `to_jsonb`), so every reader — the merge, the backfill, a diagnostic
 *    query — has to parse before it compares, and the one that forgets
 *    reports every row as changed.
 *  - Each column's NULL has one meaning ("no base"). A snapshot has three
 *    states per field (key absent, `null`, a value) for two meanings.
 *  - `status` already has its own column; a snapshot would split the bases
 *    across two representations, or rewrite #2890's.
 *  - The backfill is plain `SET source_start_time = start_time`. A snapshot's
 *    would be `jsonb_build_object` over every field, re-spelling each value.
 *
 * The only structured base is `source_recurrence`, because the value it
 * shadows is already jsonb (`metadata.recurrenceRule`).
 *
 * ── Time is one unit ────────────────────────────────────────────────────────
 *
 * Start, end and — for a series master — the recurrence rule are merged
 * together. Field by field, a user who extended a meeting and an organizer who
 * moved it produce the user's end with the organizer's start, which can be
 * inverted (`assertTimeOrder`, the `events_time_order` CHECK) and is never what
 * either meant. And a series moved from Monday to Tuesday changes its DTSTART
 * and its `BYDAY` together; taking one without the other expands it on the
 * wrong days. Within the unit only what the source moved is applied, so a
 * series that only gained an `UNTIL` keeps whatever start the row has.
 *
 * Title is the base row's `name` (`ci.entities`), merged on its own.
 */

import type { RecurrenceDefinition } from '../entities/EventEntity';

export type { RecurrenceDefinition };

/** When an event happens, as one value. */
export interface EventWhen {
  startTime: Date;
  endTime: Date | null;
  /** The rule a series master expands by; null for anything that is not one. */
  recurrence: RecurrenceDefinition | null;
}

/** What the stored row shows, plus the markers that say who else moved it. */
export interface StoredWhen extends EventWhen {
  /**
   * `start_time_original` / `end_time_original`: the times `clean.temporal_repair`
   * moved this row FROM (it shifts an all-day row's UTC midnight to the user's
   * local midnight). Null when it never moved the row.
   */
  startTimeOriginal: Date | null;
  endTimeOriginal: Date | null;
  /**
   * `last_moved_at`: the last move a person (or the planner) made, stamped by
   * `update` and `reschedule`. Neither this refresh nor the clean stage stamps
   * it, which is what lets it tell their moves from a person's.
   */
  lastMovedAt: Date | null;
}

export interface WhenMerge {
  /** The when to store: the source's for each part it moved, the row's otherwise. */
  when: EventWhen;
  /** The new merge base: always what was delivered. */
  base: EventWhen;
  /** Whether the row's start/end move — the change readers see, and the one the clean stage must redo. */
  timesChanged: boolean;
  /** Whether the row's recurrence moves. */
  recurrenceChanged: boolean;
}

export interface TitleMerge {
  title: string | null;
  base: string;
  changed: boolean;
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left.getTime() === right.getTime();
}

/**
 * Whether two events start and end at the same instants — what "the time did
 * not move" means to everything that reacts to a move (the merge here, and the
 * writers that settle the pipeline's decisions on the old time).
 */
export function sameTimes(
  left: Pick<EventWhen, 'startTime' | 'endTime'>,
  right: Pick<EventWhen, 'startTime' | 'endTime'>,
): boolean {
  return sameInstant(left.startTime, right.startTime) && sameInstant(left.endTime, right.endTime);
}

export function sameRecurrence(
  left: RecurrenceDefinition | null,
  right: RecurrenceDefinition | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return JSON.stringify(left.rule) === JSON.stringify(right.rule) && left.timeZone === right.timeZone;
}

export function sameWhen(left: EventWhen, right: EventWhen): boolean {
  return sameTimes(left, right) && sameRecurrence(left.recurrence, right.recurrence);
}

/**
 * The recurrence a delivery (or a stored row) carries in its metadata, or null
 * when it carries no rule. The zone alone is not a recurrence: the Google
 * transform records `recurrenceTimeZone` for every timed event, recurring or not.
 */
export function recurrenceOf(
  metadata: Record<string, unknown> | null | undefined,
): RecurrenceDefinition | null {
  const rule = metadata?.recurrenceRule;

  if (rule == null || (Array.isArray(rule) && rule.length === 0)) {
    return null;
  }

  const timeZone = metadata?.recurrenceTimeZone;

  return { rule, timeZone: typeof timeZone === 'string' ? timeZone : null };
}

/**
 * Whether the row shows its source's last time, as the clean stage left it: the
 * stage moved it from exactly the base, and no person has moved it since.
 * `start_time_original` survives a later pass that relabels the row, so it —
 * not `time_source = 'repaired'` — is what says the stage moved it.
 */
function repairedFrom(row: StoredWhen, base: EventWhen): boolean {
  return (
    row.startTimeOriginal !== null &&
    row.lastMovedAt === null &&
    sameTimes({ startTime: row.startTimeOriginal, endTime: row.endTimeOriginal }, base) &&
    sameRecurrence(row.recurrence, base.recurrence)
  );
}

/**
 * Merge a time the source just delivered into a row's current one.
 *
 * A NULL base means the row's time may be a person's: a row stored before
 * bases existed whose history the backfill could not clear (it was moved, or
 * edited when a move left no trace). Its time stands, and the delivered one
 * becomes the base, so the source is followed again from the moment the two
 * agree.
 *
 * @returns what to store, or `null` when there is nothing to write (the source
 *   delivered the same time it delivered last time).
 */
export function mergeSourceWhen(
  row: StoredWhen,
  base: EventWhen | null,
  delivered: EventWhen,
): WhenMerge | null {
  if (base !== null && sameWhen(base, delivered)) {
    return null;
  }

  const showsSource = base !== null && (sameWhen(row, base) || repairedFrom(row, base));

  if (!showsSource) {
    return { when: row, base: delivered, timesChanged: false, recurrenceChanged: false };
  }

  // Only the parts the source moved. A repaired row whose source only changed
  // its rule keeps the stage's times rather than going back to UTC midnight.
  const timesMoved = !sameTimes(base, delivered);
  const recurrenceMoved = !sameRecurrence(base.recurrence, delivered.recurrence);
  const when: EventWhen = {
    startTime: timesMoved ? delivered.startTime : row.startTime,
    endTime: timesMoved ? delivered.endTime : row.endTime,
    recurrence: recurrenceMoved ? delivered.recurrence : row.recurrence,
  };

  return {
    when,
    base: delivered,
    timesChanged: !sameTimes(row, when),
    recurrenceChanged: !sameRecurrence(row.recurrence, when.recurrence),
  };
}

/**
 * Merge a title the source just delivered into the row's current one. A NULL
 * base reads as for time: the title may be a person's, so it stands.
 *
 * @returns what to store, or `null` when the source repeated itself.
 */
export function mergeSourceTitle(
  row: string | null,
  base: string | null,
  delivered: string,
): TitleMerge | null {
  if (base === delivered) {
    return null;
  }

  if (base === null || row !== base) {
    return { title: row, base: delivered, changed: false };
  }

  return { title: delivered, base: delivered, changed: row !== delivered };
}
