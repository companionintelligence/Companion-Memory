/**
 * Pure task-bucketing helpers, ported from CI-Planning's
 * `client/src/lib/task-sections.ts` and `task-buckets.ts`.
 *
 * No React, no Apollo, no clock of their own — every function that needs "now"
 * or "today" takes it as an argument. That is what makes them testable without
 * a DOM and what lets the DST cases below be asserted at all.
 */

export type SectionKey = 'overdue' | 'today' | 'upcoming' | 'someday' | 'done';

export interface SectionedTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  dueAt?: string | Date | null;
  scheduledFor?: string | null;
  deferUntil?: string | null;
  completedAt?: string | Date | null;
}

export interface Section<T> {
  key: SectionKey;
  label: string;
  tasks: T[];
}

const SECTION_LABELS: Record<SectionKey, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  someday: 'Someday',
  done: 'Done',
};

const SECTION_ORDER: SectionKey[] = ['overdue', 'today', 'upcoming', 'someday', 'done'];

/**
 * The user-local calendar date (`YYYY-MM-DD`) of an instant.
 *
 * Deliberately NOT `toISOString().slice(0, 10)` — that yields the UTC date, so
 * anyone west of Greenwich sees tomorrow's tasks after their local afternoon.
 */
export function localDateOf(instant: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const lookup: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

/**
 * Which section a task belongs in, relative to a user-local `today`.
 *
 * `dueAt` is an instant and is compared by local date; `scheduledFor` and
 * `deferUntil` are already user-local `YYYY-MM-DD` strings and are compared
 * lexicographically, which is correct for a zero-padded ISO date.
 */
export function sectionFor(task: SectionedTask, today: string, timeZone?: string): SectionKey {
  if (task.status === 'done' || task.status === 'skipped' || task.status === 'archived') {
    return 'done';
  }

  // A deferred task is invisible until its date arrives, whatever its deadline.
  if (task.deferUntil && task.deferUntil > today) {
    return 'someday';
  }

  const dueDate = task.dueAt ? localDateOf(new Date(task.dueAt), timeZone) : null;
  const dates = [dueDate, task.scheduledFor].filter((d): d is string => d != null);

  if (dates.length === 0) {
    return 'someday';
  }

  const earliest = dates.reduce((a, b) => (a < b ? a : b));

  if (earliest < today) {
    return 'overdue';
  }

  if (earliest === today) {
    return 'today';
  }

  return 'upcoming';
}

/** Ascending by due date (undated last), then by priority, then by title. */
export function compareTasks(a: SectionedTask, b: SectionedTask): number {
  const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;

  if (aDue !== bDue) {
    return aDue - bDue;
  }

  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }

  return a.title.localeCompare(b.title);
}

/**
 * Groups tasks into display sections, dropping empty ones so the UI never
 * renders a bare heading.
 */
export function groupIntoSections<T extends SectionedTask>(
  tasks: readonly T[],
  today: string,
  timeZone?: string,
): Section<T>[] {
  const buckets = new Map<SectionKey, T[]>();

  for (const task of tasks) {
    const key = sectionFor(task, today, timeZone);
    const bucket = buckets.get(key);

    if (bucket) {
      bucket.push(task);
    } else {
      buckets.set(key, [task]);
    }
  }

  return SECTION_ORDER.flatMap((key) => {
    const bucket = buckets.get(key);

    if (!bucket?.length) {
      return [];
    }

    return [{ key, label: SECTION_LABELS[key], tasks: [...bucket].sort(compareTasks) }];
  });
}

/** How many tasks still want doing. Drives the nav badge. */
export function openCount(tasks: readonly SectionedTask[]): number {
  return tasks.filter((task) => task.status === 'open' || task.status === 'in_progress').length;
}
