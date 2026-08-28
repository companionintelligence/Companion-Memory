/**
 * The last good payload for each Jobs request, kept in memory for the tab.
 *
 * This page is four REST polls, each parked behind its own `useState`, so
 * leaving it threw every answer away: coming back re-mounted into skeletons and
 * an empty dashboard for as long as the appliance took to answer — seconds, on
 * a queue with a live import running, which is exactly when an operator opens
 * it. Keeping the last answer means a revisit paints the previous snapshot
 * immediately and the refetch lands underneath it.
 *
 * There is no query client to lean on here. Apollo fronts the GraphQL surface
 * only; `/api/jobs/*` and `/api/pipeline/dead-letters` go through `fetchJson`,
 * so the page keeps the one thing it needs rather than growing a cache layer.
 *
 * Memory only — a reload starts empty — and deliberately not keyed by identity:
 * these endpoints describe the appliance's queue, not a user's content (the
 * server projects job payloads away for exactly that reason), so there is
 * nothing here for the next session to inherit.
 */

export interface JobsSnapshot<T> {
  readonly value: T;
  /** When the payload arrived, as epoch millis. */
  readonly at: number;
}

/**
 * Enough for the dashboard, the dead letters, and a couple of dozen
 * filter/window combinations. The list keys on its query string, so an operator
 * typing in the search box would otherwise grow this without bound.
 */
const MAX_SNAPSHOTS = 24;

const snapshots = new Map<string, JobsSnapshot<unknown>>();

export function readJobsSnapshot<T>(key: string): JobsSnapshot<T> | null {
  return (snapshots.get(key) as JobsSnapshot<T> | undefined) ?? null;
}

export function writeJobsSnapshot<T>(key: string, value: T): JobsSnapshot<T> {
  const snapshot: JobsSnapshot<T> = { value, at: Date.now() };

  // Re-insert rather than overwrite so iteration order stays least-recently
  // written first, which is what the trim below evicts.
  snapshots.delete(key);
  snapshots.set(key, snapshot);

  for (const oldest of snapshots.keys()) {
    if (snapshots.size <= MAX_SNAPSHOTS) {
      break;
    }

    snapshots.delete(oldest);
  }

  return snapshot;
}

/** Drop every snapshot. Tests, and anything that invalidates the whole page. */
export function clearJobsSnapshots(): void {
  snapshots.clear();
}
