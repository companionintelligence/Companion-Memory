/**
 * Pure task-bucketing helpers, ported from CI-Planning's
 * `client/src/lib/task-sections.ts` and `task-buckets.ts`.
 *
 * No React, no Apollo, no clock of their own — every function that needs "now"
 * or "today" takes it as an argument. That is what makes them testable without
 * a DOM and what lets the DST cases below be asserted at all.
 */

export type ColumnKey = 'proposed' | 'unscheduled' | 'scheduled' | 'done';

export type LaneKey = 'inbox' | 'proposed_upcoming' | 'upcoming' | 'overdue';

/** @deprecated Use ColumnKey. Kept as an alias so existing imports compile. */
export type SectionKey = ColumnKey;

export interface SectionedTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  dueAt?: string | Date | null;
  scheduledFor?: string | null;
  /** True when a planned calendar block exists. `scheduledFor` alone is a hint. */
  placedOnCalendar?: boolean;
  deferUntil?: string | null;
  completedAt?: string | Date | null;
  parentId?: string | null;
  /** True when there is at least one pending automation change for this task. */
  hasPendingChange?: boolean;
}

export interface Placement {
  column: ColumnKey;
  lane: LaneKey;
}

export interface Lane<T> {
  key: LaneKey;
  /** Null when the column heading already names the list (Proposed inbox, Done). */
  label: string | null;
  tasks: T[];
  /** `tasks` plus every descendant rendered nested under them. */
  count: number;
}

export interface Section<T> {
  key: ColumnKey;
  label: string;
  lanes: Lane<T>[];
  /** Flattened lane tasks, same order as `lanes`. Roots only. */
  tasks: T[];
  /**
   * ═══ THE BADGES USED TO COUNT ONLY ROOTS ═══
   *
   * Children render nested under their parent, so they are in this column and
   * actionable there — but `tasks` never held them, so a column of three roots
   * with nine live subtasks read "3". Worst case an unchecked, overdue subtask
   * sits inside the Done column purely by nesting: invisible to Unscheduled,
   * with nothing saying Done contains live work.
   */
  count: number;
  /** How many tasks in this column (roots and descendants) are overdue. */
  overdueCount: number;
}

const COLUMN_LABELS: Record<ColumnKey, string> = {
  proposed: 'Proposed',
  unscheduled: 'Unscheduled',
  scheduled: 'Scheduled on calendar',
  done: 'Done',
};

const LANE_LABELS: Record<LaneKey, string | null> = {
  inbox: null,
  proposed_upcoming: 'Proposed upcoming',
  upcoming: 'Upcoming',
  overdue: 'Overdue',
};

const COLUMN_ORDER: ColumnKey[] = ['proposed', 'unscheduled', 'scheduled', 'done'];

/** Inbox and Upcoming first; Proposed upcoming / Overdue follow in list order. */
const LANE_ORDER: Record<ColumnKey, LaneKey[]> = {
  proposed: ['inbox', 'proposed_upcoming'],
  unscheduled: ['upcoming', 'overdue'],
  scheduled: ['upcoming', 'overdue'],
  done: ['inbox'],
};

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
 * Which Kanban column and lane a task belongs in, relative to a user-local `today`.
 *
 * Mapping from the previous flat sections:
 *   proposed + needs confirmation → Proposed / inbox
 *   still-deferred → Proposed / Proposed upcoming
 *   accepted work without a calendar block (dated or not) → Unscheduled
 *   those same date buckets with a placed calendar block → Scheduled on calendar
 *   `scheduledFor` without a block is a preferred date, not a placement.
 *   done / skipped / archived → Done
 *
 * `dueAt` is an instant and is compared by local date; `scheduledFor` and
 * `deferUntil` are already user-local `YYYY-MM-DD` strings and are compared
 * lexicographically, which is correct for a zero-padded ISO date.
 */
export function sectionFor(task: SectionedTask, today: string, timeZone?: string): Placement {
  if (task.status === 'proposed' || task.hasPendingChange) {
    return { column: 'proposed', lane: 'inbox' };
  }

  if (task.status === 'done' || task.status === 'skipped' || task.status === 'archived') {
    return { column: 'done', lane: 'inbox' };
  }

  // A deferred task is invisible until its date arrives, whatever its deadline.
  if (task.deferUntil && task.deferUntil > today) {
    return { column: 'proposed', lane: 'proposed_upcoming' };
  }

  const dueDate = task.dueAt ? localDateOf(new Date(task.dueAt), timeZone) : null;
  const dates = [dueDate, task.scheduledFor].filter((d): d is string => d != null);

  if (dates.length === 0) {
    // Plan accepts a proposal into the open backlog. No date is still
    // accepted work — Unscheduled — not a second Proposed pile the inbox
    // just hid the card in.
    return { column: 'unscheduled', lane: 'upcoming' };
  }

  const earliest = dates.reduce((a, b) => (a < b ? a : b));
  const column: ColumnKey = task.placedOnCalendar ? 'scheduled' : 'unscheduled';
  const lane: LaneKey = earliest < today ? 'overdue' : 'upcoming';

  return { column, lane };
}

/** True when the task would render in an Overdue lane for `today`. */
export function isOverdue(task: SectionedTask, today: string, timeZone?: string): boolean {
  return sectionFor(task, today, timeZone).lane === 'overdue';
}

/** Shift a user-local `YYYY-MM-DD` by a number of calendar days. */
export function addLocalDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);

  date.setDate(date.getDate() + days);

  return localDateOf(date);
}

/** Noon on a user-local calendar date, as an instant — matches the edit-due control. */
export function dueAtFromLocalDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);

  return new Date(year, month - 1, day, 12).toISOString();
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

function emptyLanes(): Record<ColumnKey, Record<LaneKey, SectionedTask[]>> {
  return {
    proposed: { inbox: [], proposed_upcoming: [], upcoming: [], overdue: [] },
    unscheduled: { inbox: [], proposed_upcoming: [], upcoming: [], overdue: [] },
    scheduled: { inbox: [], proposed_upcoming: [], upcoming: [], overdue: [] },
    done: { inbox: [], proposed_upcoming: [], upcoming: [], overdue: [] },
  };
}

/** A root and every task nested beneath it, guarding against a `parentId` cycle. */
function subtreeOf<T extends SectionedTask>(root: T, childrenByParent: Map<string, T[]>): T[] {
  const out: T[] = [];
  const stack: T[] = [root];
  const seen = new Set<string>();

  while (stack.length) {
    const next = stack.pop() as T;

    if (seen.has(next.id)) {
      continue;
    }

    seen.add(next.id);
    out.push(next);
    stack.push(...(childrenByParent.get(next.id) ?? []));
  }

  return out;
}

/**
 * Groups tasks into Kanban columns with lanes, dropping empty columns and
 * empty lanes so the UI never renders a bare heading.
 *
 * Only roots are sectioned; children stay nested under their parent via
 * `parentId` (rendered by the Plan page tree). They are still *counted* into
 * the column their root landed in — see `Section.count`.
 */
export function groupIntoSections<T extends SectionedTask>(
  tasks: readonly T[],
  today: string,
  timeZone?: string,
): Section<T>[] {
  const roots = tasks.filter((task) => !task.parentId);
  const childrenByParent = new Map<string, T[]>();

  for (const task of tasks) {
    if (task.parentId) {
      const siblings = childrenByParent.get(task.parentId);

      if (siblings) {
        siblings.push(task);
      } else {
        childrenByParent.set(task.parentId, [task]);
      }
    }
  }

  const buckets = emptyLanes() as Record<ColumnKey, Record<LaneKey, T[]>>;

  for (const task of roots) {
    const { column, lane } = sectionFor(task, today, timeZone);
    buckets[column][lane].push(task);
  }

  return COLUMN_ORDER.flatMap((column) => {
    const lanes = LANE_ORDER[column].flatMap((lane) => {
      const bucket = buckets[column][lane];

      if (!bucket.length) {
        return [];
      }

      const sorted = [...bucket].sort(compareTasks);
      const rendered = sorted.flatMap((task) => subtreeOf(task, childrenByParent));

      return [{ key: lane, label: LANE_LABELS[lane], tasks: sorted, count: rendered.length, rendered }];
    });

    if (!lanes.length) {
      return [];
    }

    const rendered = lanes.flatMap((lane) => lane.rendered);

    return [
      {
        key: column,
        label: COLUMN_LABELS[column],
        lanes: lanes.map(({ rendered: _rendered, ...lane }) => lane),
        tasks: lanes.flatMap((lane) => lane.tasks),
        count: rendered.length,
        overdueCount: rendered.filter((task) => isOverdue(task, today, timeZone)).length,
      },
    ];
  });
}

/** Plan's four columns, with empty buckets kept so the tabs never disappear. */
export function withAllColumns<T extends SectionedTask>(sections: readonly Section<T>[]): Section<T>[] {
  const byKey = new Map(sections.map((section) => [section.key, section]));

  return COLUMN_ORDER.map(
    (key) =>
      byKey.get(key) ?? {
        key,
        label: COLUMN_LABELS[key],
        lanes: [],
        tasks: [],
        count: 0,
        overdueCount: 0,
      },
  );
}

/** Direct children of `parentId`, sorted like section rows. */
export function childrenOf<T extends SectionedTask>(tasks: readonly T[], parentId: string): T[] {
  return tasks.filter((task) => task.parentId === parentId).sort(compareTasks);
}

/** How many tasks still want doing. Drives the nav badge. */
export function openCount(tasks: readonly SectionedTask[]): number {
  return tasks.filter(
    (task) =>
      task.status === 'open' ||
      task.status === 'in_progress' ||
      task.status === 'proposed' ||
      task.hasPendingChange,
  ).length;
}
