/**
 * The status refresh for events a source owns, as a pure function.
 *
 * A calendar connection re-delivers an event when it changes, and the status it
 * carries may have moved — confirmed at the first sync, cancelled since. The
 * row's `status` cannot simply take the new value, because it is also the
 * user's: `updateEvent` writes it, and a meeting the user marked `no_show`
 * must not turn back into `confirmed` because the organizer edited its agenda.
 * `status` alone cannot say which of the two last wrote it.
 *
 * `ci.events.source_status` can. It holds what the source delivered LAST time,
 * so a re-delivery is a three-way merge:
 *
 *  - the row still shows the source's last value → nobody else touched it, and
 *    the source's new value lands;
 *  - the row shows anything else → the user changed it, and that stands;
 *  - either way the new value becomes the base, so once the user and the source
 *    agree again, the source's later changes flow through.
 *
 * A NULL base means no source ever asserted a status for the row, which leaves
 * it at the column DEFAULT — so the base is read as that default.
 */

/** What `ci.events.status` holds when nothing asserted a status: its column DEFAULT. */
export const DEFAULT_EVENT_STATUS = 'confirmed';

export interface SourceStatusState {
  /** What the row shows (`ci.events.status`). */
  status: string;
  /** What its source delivered last time (`ci.events.source_status`); null when none has said. */
  sourceStatus: string | null;
}

export interface SourceStatusMerge extends SourceStatusState {
  /** Whether `status` itself moves — the only part of the merge any reader can see. */
  statusChanged: boolean;
}

/**
 * Merge a status the source just delivered into a row's current state.
 *
 * @returns the state to write, or `null` when there is nothing to write (the
 *   source delivered the same status it delivered last time).
 */
export function mergeSourceStatus(row: SourceStatusState, delivered: string): SourceStatusMerge | null {
  if (row.sourceStatus === delivered) {
    return null;
  }

  const base = row.sourceStatus ?? DEFAULT_EVENT_STATUS;
  const status = row.status === base ? delivered : row.status;

  return { status, sourceStatus: delivered, statusChanged: status !== row.status };
}
