/**
 * Drag payload keys for the schedule surface.
 *
 * They live here rather than beside either component because HorizonGrid and
 * VerticalCalendar both accept the same payload from TaskSlate. Declaring the
 * key on the emitter would make the grids import the rail, or the rail import
 * the grids.
 *
 * Mouse placement uses native HTML5 drag-and-drop. Touch has no HTML5 drag
 * events, so Possibilities cards use a hold-then-drop pointer protocol
 * (`schedulePointerDrag.ts`) that lands on the same Calendar and Horizon
 * targets. There is still no keyboard write path — chips and cards are
 * focusable so the week can be READ without a pointer.
 */

/** A Plan backlog task being dragged out of Possibilities. Payload: the task id. */
export const CANDIDATE_DRAG_TYPE = 'application/x-ci-candidate';

/** A committed event being dragged. Payload: {@link EventDragPayload} as JSON. */
export const EVENT_DRAG_TYPE = 'application/x-ci-event';

/**
 * Present on the drag when the event mirrors a row an external calendar owns.
 *
 * It exists as a KEY rather than a field because the DnD protection mode blanks
 * `getData` during `dragover` — only `types` is legible mid-drag. Without it the
 * rail would light up and promise "drop to take it off the week" for a Google
 * event it is going to refuse, which is a worse way to learn than never
 * offering.
 */
export const EVENT_EXTERNAL_DRAG_TYPE = 'application/x-ci-event-external';

/** True when this drag carries an event no candidate stands behind. */
export function isExternallyOwnedDrag(types: readonly string[]): boolean {
  return types.includes(EVENT_EXTERNAL_DRAG_TYPE);
}

export interface EventDragPayload {
  id: string;
  /** Milliseconds between the event's real start and where the user grabbed it. */
  grabOffsetMs: number;
  /**
   * Set when the event mirrors a row an external calendar owns. Returning such
   * an event to the slate is refused server-side (there is no candidate behind
   * it), so the rail uses this to decline the drop up front rather than let the
   * user complete a gesture that will fail.
   */
  externallyOwned?: boolean;
}

/** Read an event drag payload back, tolerating anything that is not ours. */
export function parseEventDrag(raw: string): EventDragPayload | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<EventDragPayload>;

    if (typeof parsed.id !== 'string' || !Number.isFinite(parsed.grabOffsetMs)) {
      return null;
    }

    return {
      id: parsed.id,
      grabOffsetMs: parsed.grabOffsetMs as number,
      externallyOwned: parsed.externallyOwned === true,
    };
  } catch {
    return null;
  }
}
