import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

/** Dragged at least this far (px) and let go: the sheet goes. */
const DISMISS_DISTANCE_PX = 96;

/** A flick: this fast (px per ms) over at least `FLICK_MIN_DISTANCE_PX` is a dismissal too. */
const FLICK_VELOCITY_PX_PER_MS = 0.5;
const FLICK_MIN_DISTANCE_PX = 24;

/** How long the sheet takes to leave, or to come back when the drag is let go short. */
const SETTLE_MS = 180;

interface Options {
  /** False leaves the gesture off entirely: no handlers, no touch-action, no transform. */
  enabled: boolean;
  /**
   * Called once the sheet has slid off the screen. Closing it is the caller's
   * to do: the sheet is left where it landed, off-screen, until it is unmounted.
   */
  onDismiss: () => void;
}

interface Gesture {
  pointerId: number;
  startY: number;
  startedAt: number;
  /** How far down it has been dragged. Never negative: a sheet cannot be pulled up off its anchor. */
  offset: number;
}

/**
 * Swipe-down-to-dismiss for a bottom sheet.
 *
 * The sheets here wear a grabber bar, which promises that dragging them down
 * closes them — and until this existed nothing did (REFL-08: three swipes left
 * the provenance sheet open; only Close worked). The primitive underneath is a
 * plain Radix dialog with CSS slide animations, which has no gesture of its own.
 *
 * Spread `handleProps` on the part of the sheet that is NOT a scroller — the
 * grabber and the header — and put `sheetRef` on the element that should move.
 * `handleProps` carries `touch-action: none`, which is what keeps the browser
 * from taking the touch for a scroll and cancelling the pointer events mid-drag;
 * it is deliberately absent from the body, which has to stay scrollable. So
 * dragging from the handle is the whole gesture: a drag that starts in the body
 * is a scroll, never a dismissal.
 *
 * The transform is written straight onto the element rather than through state,
 * so a drag does not re-render the sheet sixty times a second. The sheet's own
 * classes carry a `transition` (500ms while open), so a drag clears it for the
 * duration or the sheet would trail the finger.
 */
export function useSwipeToDismiss<T extends HTMLElement = HTMLElement>({ enabled, onDismiss }: Options) {
  const sheetRef = useRef<T>(null);
  const gesture = useRef<Gesture | null>(null);
  const leaving = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  // Read through a ref so a caller's inline callback does not matter.
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const place = (offset: number) => {
    const sheet = sheetRef.current;

    if (sheet) {
      sheet.style.transition = 'none';
      sheet.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
    }
  };

  const settle = (dismiss: boolean) => {
    const sheet = sheetRef.current;

    if (dismiss) {
      leaving.current = true;
    }

    // Someone who asks for less motion gets the end state straight away.
    if (!sheet || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sheet?.style.removeProperty('transition');

      if (dismiss) {
        sheet?.style.setProperty('transform', 'translateY(100%)');
        onDismissRef.current();
      } else {
        sheet?.style.removeProperty('transform');
      }

      return;
    }

    sheet.style.transition = `transform ${SETTLE_MS}ms ease-out`;
    sheet.style.transform = dismiss ? 'translateY(100%)' : '';

    timer.current = window.setTimeout(() => {
      if (dismiss) {
        onDismissRef.current();
      } else {
        sheet.style.removeProperty('transition');
      }
    }, SETTLE_MS);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // The primary pointer only (the first finger, the left button), and never a
    // sheet that is already on its way out.
    if (!event.isPrimary || event.button !== 0 || leaving.current) {
      return;
    }

    // A snap-back that is still easing is cut short: the new drag takes over.
    window.clearTimeout(timer.current);
    gesture.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startedAt: Date.now(),
      offset: 0,
    };

    // Keeps the move and up events coming when the finger leaves the handle.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;

    if (!current || event.pointerId !== current.pointerId) {
      return;
    }

    current.offset = Math.max(0, event.clientY - current.startY);
    place(current.offset);
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;

    if (!current || event.pointerId !== current.pointerId) {
      return;
    }

    // The capture ends by itself with the pointer; nothing to release.
    gesture.current = null;

    const velocity = current.offset / Math.max(1, Date.now() - current.startedAt);
    // A cancelled pointer (the system took the touch) never dismisses.
    const dismiss =
      event.type === 'pointerup' &&
      (current.offset >= DISMISS_DISTANCE_PX ||
        (current.offset >= FLICK_MIN_DISTANCE_PX && velocity >= FLICK_VELOCITY_PX_PER_MS));

    settle(dismiss);
  };

  const style: CSSProperties = { touchAction: 'none' };

  return {
    sheetRef,
    handleProps: enabled
      ? { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, style }
      : {},
  };
}
