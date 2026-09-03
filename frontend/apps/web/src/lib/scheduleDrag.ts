/**
 * Drag payload key for the schedule surface.
 *
 * It lives here rather than beside VerticalCalendar so the emitter (an event
 * chip) and the target (a day lane) name the same key without either importing
 * the other.
 *
 * Moving a placed event by dragging is a MOUSE gesture: it rides on native
 * HTML5 drag-and-drop, which does not fire on touch. A phone moves an event
 * from the chip's peek dialog instead (see `VerticalCalendar`'s `MoveEventForm`).
 * There is still no keyboard write path — chips are focusable so the week can
 * be READ without a pointer.
 */

/** A committed event being dragged. Payload: {@link EventDragPayload} as JSON. */
export const EVENT_DRAG_TYPE = 'application/x-ci-event';

export interface EventDragPayload {
  id: string;
  /** Milliseconds between the event's real start and where the user grabbed it. */
  grabOffsetMs: number;
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

    return { id: parsed.id, grabOffsetMs: parsed.grabOffsetMs as number };
  } catch {
    return null;
  }
}
