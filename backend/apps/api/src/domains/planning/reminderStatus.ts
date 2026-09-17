/**
 * The `ci.reminders.status` / `.source` vocabularies.
 *
 * Small on purpose, unlike `taskStatus.ts`'s named-subset machinery: this
 * milestone ships exactly two claim states that matter to a filter
 * (`pending`, `fired`) plus a soft-delete (`cancelled`), and one active source
 * (`manual`) plus one reserved-but-unwritten one (`auto`, for the not-yet-built
 * due-date derivation engine — see the migration header comment). If a third
 * meaningfully-different status is ever added, promote this file to
 * `taskStatus.ts`'s discipline (named subsets + a completeness test) rather
 * than growing ad-hoc literals at each call site — that omission is exactly
 * what #2558 got bitten by for `ci.tasks.status`.
 */

export const REMINDER_STATUSES = ['pending', 'fired', 'cancelled'] as const;

export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const REMINDER_SOURCES = ['manual', 'auto'] as const;

export type ReminderSource = (typeof REMINDER_SOURCES)[number];

/**
 * Task statuses that suppress a task-targeted reminder at claim time.
 *
 * Re-exported here (rather than importing `CLOSED_TASK_STATUSES` at every call
 * site) so the dispatcher's raw SQL literal and this list are reviewed
 * together — the SQL cannot import a TypeScript array, so
 * `ReminderDispatchService`'s query string and `TERMINAL_TASK_STATUSES` must
 * be kept in sync by hand, and a test pins that they are.
 */
export const TERMINAL_TASK_STATUSES = ['done', 'skipped', 'archived'] as const;

/**
 * Block (`ci.events`) statuses that suppress a block-targeted reminder at
 * claim time. Mirrors `DEAD_EVENT_STATUSES` from `@ci/domains/memory` — a
 * planned block that would not be drawn on the calendar should not buzz
 * anyone either.
 */
export const TERMINAL_BLOCK_STATUSES = ['cancelled', 'no_show', 'skipped'] as const;
