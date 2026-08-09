export const DEFAULT_QUEUE = 'default';

// ---------------------------------------------------------------------------
// Job priority tiers.
//
// pg-boss fetches `ORDER BY priority DESC, created_on, id`, so a HIGHER number
// is worked SOONER. Priority only reorders jobs that are already waiting on the
// SAME queue — it does not preempt a running job and it does not arbitrate
// between queues (that is what the per-queue semaphores do). Three named tiers
// instead of ad-hoc magic numbers, so a call site declares intent ("this is a
// backfill") rather than a number whose meaning has to be reverse-engineered
// from the other call sites.
// ---------------------------------------------------------------------------

/**
 * Priority every job carries unless a caller asks for something else. Mirrors
 * pg-boss's own column default, so stating it explicitly changes no behaviour —
 * it just makes the baseline the other tiers are relative to visible at the call
 * site.
 */
export const DEFAULT_JOB_PRIORITY = 0;

/**
 * Work a human is currently waiting on: a chat turn, an upload the UI is showing
 * a spinner for, a tool call inside a live conversation. Jumps ahead of ordinary
 * traffic already queued.
 */
export const INTERACTIVE_JOB_PRIORITY = 10;

/**
 * Bulk/catch-up work with no one waiting: backfills, re-index sweeps, importer
 * fan-out, cron-driven maintenance. Sinks BELOW ordinary traffic so a million-row
 * backfill queued at 09:00 cannot delay a user action queued at 09:01 — without
 * it, ordinary work sits behind the whole backlog in `created_on` order.
 */
export const BACKFILL_JOB_PRIORITY = -10;
