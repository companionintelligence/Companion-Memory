/**
 * The two addresses the Memory explorer answers to, and what each one means.
 *
 * `/memory` is the everything browse: every kind of memory, ranked by
 * relevance, with no promise that rows sit in time order. `/memory/events` is
 * the happenings browse: things that occurred, newest first, with the activity
 * heatmap alongside. Both render the same page component and read the same
 * URL filters; the pathname is what decides which list shape, which sort
 * presets and whether the heatmap shows (see DesktopMemoryPage, SortControl
 * and useExplorerWhenReset).
 */
export const MEMORY_EXPLORER_PATH = '/memory';
export const EVENTS_EXPLORER_PATH = '/memory/events';

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** The everything browse — a bare `/memory`, not a `/memory/<kind>` page. */
export function isEverythingExplorer(pathname: string): boolean {
  return normalizePathname(pathname) === MEMORY_EXPLORER_PATH;
}

/** The happenings browse that the Events submenu opens. */
export function isEventsExplorer(pathname: string): boolean {
  return normalizePathname(pathname) === EVENTS_EXPLORER_PATH;
}

/**
 * The only kinds the events browse shows or lets the What bar pick: the ones
 * whose rows carry the moment they happened. Receipts have a purchase date
 * too, but they have their own page. Display names, as the What picker and
 * the `includedEntityTypes` / `excludedEntityTypes` params spell them.
 */
export const EVENTS_EXPLORER_TYPES: readonly string[] = ['Browser', 'Communication', 'Event'];
