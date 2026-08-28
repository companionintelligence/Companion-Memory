/**
 * Touch/pen drag for placing Possibilities on the schedule.
 *
 * HTML5 drag-and-drop does not fire on touch (see scheduleDrag.ts), so Calendar
 * and Horizon share this pointer protocol instead: hold a card, then drop it on
 * a day. Mouse still uses HTML5. Drop targets mark themselves with
 * {@link SCHEDULE_DROP_AXIS_ATTR} and read the store on move/end.
 */

export const SCHEDULE_DROP_AXIS_ATTR = 'data-schedule-drop-axis';
export const SCHEDULE_SCROLL_ATTR = 'data-schedule-scroll';
export const SCHEDULE_DROP_SELECTOR = `[${SCHEDULE_DROP_AXIS_ATTR}]`;

/** Hold this long before a touch becomes a drag, so a flick still scrolls. */
export const HOLD_MS = 280;
/** Pointer travel during the hold that cancels it (the user is scrolling). */
export const CANCEL_PX = 12;

export type ScheduleDropAxis = 'x' | 'y';

export type SchedulePointerPayload =
  | { kind: 'candidate'; id: string; title: string }
  | { kind: 'event'; id: string; title: string; grabOffsetMs: number };

export interface SchedulePointerDrag {
  payload: SchedulePointerPayload;
  x: number;
  y: number;
}

type MoveListener = (drag: SchedulePointerDrag | null) => void;
type EndListener = (drag: SchedulePointerDrag) => void;

let drag: SchedulePointerDrag | null = null;
const moveListeners = new Set<MoveListener>();
const endListeners = new Set<EndListener>();
const storeListeners = new Set<() => void>();
let scrollRaf = 0;

const SCROLL_EDGE_PX = 48;
const SCROLL_STEP_PX = 14;

function emitStore() {
  for (const listener of storeListeners) {
    listener();
  }
}

function emitMove() {
  for (const listener of moveListeners) {
    listener(drag);
  }
}

function tickAutoScroll() {
  if (!drag) {
    scrollRaf = 0;
    return;
  }

  const { x, y } = drag;

  if (y < SCROLL_EDGE_PX) {
    window.scrollBy(0, -SCROLL_STEP_PX);
  } else if (y > window.innerHeight - SCROLL_EDGE_PX) {
    window.scrollBy(0, SCROLL_STEP_PX);
  }

  const pane = document.elementFromPoint(x, y)?.closest(`[${SCHEDULE_SCROLL_ATTR}]`);

  if (pane instanceof HTMLElement) {
    const box = pane.getBoundingClientRect();

    if (y < box.top + SCROLL_EDGE_PX) {
      pane.scrollTop -= SCROLL_STEP_PX;
    } else if (y > box.bottom - SCROLL_EDGE_PX) {
      pane.scrollTop += SCROLL_STEP_PX;
    }
  }

  scrollRaf = requestAnimationFrame(tickAutoScroll);
}

function startAutoScroll() {
  if (!scrollRaf) {
    scrollRaf = requestAnimationFrame(tickAutoScroll);
  }
}

function stopAutoScroll() {
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
  }
}

export function getSchedulePointerDrag(): SchedulePointerDrag | null {
  return drag;
}

export function subscribeSchedulePointerDrag(onStoreChange: () => void): () => void {
  storeListeners.add(onStoreChange);

  return () => {
    storeListeners.delete(onStoreChange);
  };
}

export function subscribeSchedulePointerMove(listener: MoveListener): () => void {
  moveListeners.add(listener);

  return () => {
    moveListeners.delete(listener);
  };
}

export function subscribeSchedulePointerEnd(listener: EndListener): () => void {
  endListeners.add(listener);

  return () => {
    endListeners.delete(listener);
  };
}

export function startSchedulePointerDrag(payload: SchedulePointerPayload, x: number, y: number): void {
  drag = { payload, x, y };
  emitStore();
  emitMove();
  startAutoScroll();
}

export function moveSchedulePointerDrag(x: number, y: number): void {
  if (!drag) {
    return;
  }

  drag = { ...drag, x, y };
  emitStore();
  emitMove();
}

export function endSchedulePointerDrag(x: number, y: number): void {
  if (!drag) {
    return;
  }

  const finished = { ...drag, x, y };
  drag = null;
  stopAutoScroll();

  for (const listener of endListeners) {
    listener(finished);
  }

  emitStore();
  emitMove();
}

export function cancelSchedulePointerDrag(): void {
  if (!drag) {
    return;
  }

  drag = null;
  stopAutoScroll();
  emitStore();
  emitMove();
}

export function dropElementAt(x: number, y: number): HTMLElement | null {
  // Walk the hit stack so a Possibilities drop still lands when the finger is
  // over an event chip, a drag ghost, or anything else sitting on the day.
  const stack =
    typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)];

  for (const node of stack) {
    if (!(node instanceof Element)) {
      continue;
    }

    const hit = node.closest(SCHEDULE_DROP_SELECTOR);

    if (hit instanceof HTMLElement) {
      return hit;
    }
  }

  return null;
}

export function ratioOnAxis(el: HTMLElement, axis: ScheduleDropAxis, x: number, y: number): number {
  const box = el.getBoundingClientRect();

  if (axis === 'y') {
    return box.height === 0 ? 0 : (y - box.top) / box.height;
  }

  return box.width === 0 ? 0 : (x - box.left) / box.width;
}

export function axisOfDropElement(el: HTMLElement): ScheduleDropAxis | null {
  const axis = el.getAttribute(SCHEDULE_DROP_AXIS_ATTR);

  return axis === 'x' || axis === 'y' ? axis : null;
}
