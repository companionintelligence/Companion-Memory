import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** A closed drawer can be pulled out by a touch that starts this close (px) to the left edge. */
export const EDGE_PX = 40;

/** Movement (px) before a touch counts as a drag in one direction or the other. */
const SLOP_PX = 10;

/** A release this fast (px per ms) settles the drawer in the flick's direction, however far it got. */
const FLICK_PX_PER_MS = 0.4;

/** Only the last stretch of the drag sets the release speed. */
const VELOCITY_WINDOW_MS = 100;

/** How long the drawer takes to finish opening or closing once the finger lets go. */
export const SETTLE_MS = 200;

type Mode = 'open' | 'close';

interface Gesture {
  mode: Mode;
  startX: number;
  startY: number;
  /** The drawer's width when the touch began: how far it travels between shut and open. */
  width: number;
  /** False until the touch has moved past the slop horizontally. */
  dragging: boolean;
  /** How far open the drawer sits under the finger, 0 (shut) to 1 (open). */
  progress: number;
  samples: { x: number; t: number }[];
}

const MODAL_ROLES = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * True when the touch belongs to something else that reads a sideways drag:
 * a text field, an open dialog or menu, a map or canvas that has claimed its
 * own touch handling, or a sideways scroller with somewhere to go.
 */
export function touchBelongsElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return true;
  }

  // Radix turns pointer events off on the body while a modal layer is open.
  // The drawer has no business sliding out under a sheet or a dialog.
  if (document.body.style.pointerEvents === 'none' || target.closest(MODAL_ROLES)) {
    return true;
  }

  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
    return true;
  }

  for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const touchAction = style.touchAction;

    // `none` (Leaflet, d3-zoom, the sheets' grabbers) or anything that leaves
    // out sideways panning: that element runs the gesture itself.
    if (
      touchAction &&
      touchAction !== 'auto' &&
      touchAction !== 'manipulation' &&
      !touchAction.includes('pan-x')
    ) {
      return true;
    }

    // A swipe right scrolls a sideways strip back towards its start. Once it
    // is there, the drawer may have the swipe.
    const scrollsSideways = style.overflowX === 'auto' || style.overflowX === 'scroll';

    if (scrollsSideways && node.scrollWidth > node.clientWidth && node.scrollLeft > 0) {
      return true;
    }
  }

  return false;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function releaseVelocity(samples: Gesture['samples']): number {
  const last = samples[samples.length - 1];
  const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? last;
  const elapsed = last.t - first.t;

  return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
}

interface Options {
  expanded: boolean;
  openOverlay: () => void;
  closeOverlay: () => void;
  scrimRef: RefObject<HTMLElement | null>;
}

/**
 * The phone drawer follows the finger, the way an Android or iOS drawer does.
 *
 * Shut, a touch that starts in the {@link EDGE_PX} strip at the left edge and
 * moves right pulls the drawer out under the finger. Open, a touch that starts
 * on the drawer or on the scrim beside it and moves left pushes it back. On
 * release the drawer settles open or shut: past halfway it stays open, short
 * of it it goes back, and a flick wins over either.
 *
 * A pull from the edge opens the drawer as soon as it claims the touch, so
 * what slides out under the finger is the drawer as it looks open (labels and
 * all), not the icon-only rows it keeps while shut; let go short of halfway,
 * it closes again.
 *
 * The position is written straight onto the drawer (`#power-rail`) and the
 * scrim rather than through state, so a drag does not re-render the rail
 * sixty times a second. The drawer's `-translate-x-full` / `translate-x-0`
 * classes use the CSS `translate` property (Tailwind 4), so the inline value
 * is `translate` too; it overrides the class until the drawer has settled,
 * then comes off with nothing left to jump.
 *
 * The listeners go on the document once, in the capture phase. Once, because
 * WKWebView decides whether a touch sequence may cancel scrolling when it
 * begins, so a non-passive `touchmove` added mid-gesture could never stop the
 * page scrolling under a drag (see PullToRefresh). Capture, so a drag that
 * has claimed the touch can `preventDefault()` it before PullToRefresh sees
 * it, and PullToRefresh leaves a claimed touch alone.
 *
 * Returns `dragging`, true from the moment a drag claims the touch until the
 * drawer has settled, so the scrim can stay on screen while it fades out
 * after a close; and `attachScrim`, the scrim's ref, which puts a scrim that
 * mounts mid-drag straight at the drag's shade instead of full for a frame.
 */
export function useDrawerSwipe({ expanded, openOverlay, closeOverlay, scrimRef }: Options) {
  const [dragging, setDragging] = useState(false);

  // Read through refs so the listeners can be registered once (see above).
  const state = useRef({ expanded, openOverlay, closeOverlay });
  const gestureRef = useRef<Gesture | null>(null);

  const attachScrim = useCallback(
    (element: HTMLElement | null) => {
      scrimRef.current = element;

      const current = gestureRef.current;

      if (element && current?.dragging) {
        element.style.transition = 'none';
        element.style.opacity = String(current.progress);
      }
    },
    [scrimRef],
  );

  useEffect(() => {
    state.current = { expanded, openOverlay, closeOverlay };
  }, [expanded, openOverlay, closeOverlay]);

  useEffect(() => {
    let settleTimer: number | undefined;

    const drawer = () => document.getElementById('power-rail');

    const place = (current: Gesture) => {
      const nav = drawer();

      if (nav) {
        nav.style.transition = 'none';
        nav.style.translate = `${(current.progress - 1) * current.width}px 0`;
      }

      const scrim = scrimRef.current;

      if (scrim) {
        scrim.style.transition = 'none';
        scrim.style.opacity = String(current.progress);
      }
    };

    // Settled open, the classes now say exactly what the inline style does,
    // so it can come off. Settled shut, the scrim keeps its inline 0 until it
    // unmounts: taking it off first would flash it back to full for a frame.
    const clearInline = (open: boolean) => {
      const nav = drawer();
      const scrim = scrimRef.current;

      nav?.style.removeProperty('transition');
      nav?.style.removeProperty('translate');

      if (open) {
        scrim?.style.removeProperty('transition');
        scrim?.style.removeProperty('opacity');
      }
    };

    const settle = (open: boolean) => {
      const nav = drawer();
      const scrim = scrimRef.current;
      const animate = !prefersReducedMotion();

      if (nav) {
        nav.style.transition = animate ? `translate ${SETTLE_MS}ms ease-out` : 'none';
        nav.style.translate = open ? '0 0' : '-100% 0';
      }

      if (scrim) {
        scrim.style.transition = animate ? `opacity ${SETTLE_MS}ms ease-out` : 'none';
        scrim.style.opacity = open ? '1' : '0';
      }

      if (open !== state.current.expanded) {
        if (open) {
          state.current.openOverlay();
        } else {
          state.current.closeOverlay();
        }
      }

      // A new drag that starts before this fires cancels it and takes over.
      settleTimer = window.setTimeout(
        () => {
          settleTimer = undefined;
          clearInline(open);
          setDragging(false);
        },
        animate ? SETTLE_MS : 0,
      );
    };

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];

      if (event.touches.length !== 1 || !touch) {
        // A second finger cancels a drag in progress: back where it started.
        if (gestureRef.current?.dragging) {
          settle(gestureRef.current.mode === 'close');
        }

        gestureRef.current = null;

        return;
      }

      const nav = drawer();

      if (!nav) {
        return;
      }

      const { expanded: open } = state.current;
      const target = event.target;
      let mode: Mode | null = null;

      if (!open && touch.clientX <= EDGE_PX && !touchBelongsElsewhere(target)) {
        mode = 'open';
      } else if (
        open &&
        target instanceof Node &&
        (nav.contains(target) || target === scrimRef.current) &&
        !touchBelongsElsewhere(target)
      ) {
        mode = 'close';
      }

      if (!mode) {
        gestureRef.current = null;

        return;
      }

      gestureRef.current = {
        mode,
        startX: touch.clientX,
        startY: touch.clientY,
        width: nav.getBoundingClientRect().width || 300,
        dragging: false,
        progress: mode === 'open' ? 0 : 1,
        samples: [{ x: touch.clientX, t: Date.now() }],
      };
    };

    const onMove = (event: TouchEvent) => {
      const current = gestureRef.current;
      const touch = event.touches[0];

      if (!current || !touch) {
        return;
      }

      const dx = touch.clientX - current.startX;
      const dy = touch.clientY - current.startY;

      if (!current.dragging) {
        if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) {
          return;
        }

        const wrongWay = current.mode === 'open' ? dx <= 0 : dx >= 0;

        // Up, down or the wrong way: a scroll, not a drawer drag.
        if (Math.abs(dy) >= Math.abs(dx) || wrongWay) {
          gestureRef.current = null;

          return;
        }

        current.dragging = true;
        window.clearTimeout(settleTimer);
        settleTimer = undefined;
        setDragging(true);

        if (current.mode === 'open') {
          state.current.openOverlay();
        }
      }

      // The finger owns the drawer now. No scroll, no pull-to-refresh.
      if (event.cancelable) {
        event.preventDefault();
      }

      const start = current.mode === 'open' ? 0 : 1;
      current.progress = Math.min(1, Math.max(0, start + dx / current.width));
      current.samples.push({ x: touch.clientX, t: Date.now() });

      if (current.samples.length > 8) {
        current.samples.shift();
      }

      place(current);
    };

    const onEnd = (event: TouchEvent) => {
      const current = gestureRef.current;

      if (!current || event.touches.length > 0) {
        return;
      }

      gestureRef.current = null;

      if (!current.dragging) {
        return;
      }

      // The system took the touch (an incoming call, the notification shade):
      // back where it started.
      if (event.type === 'touchcancel') {
        settle(current.mode === 'close');

        return;
      }

      const velocity = releaseVelocity(current.samples);
      let open = current.progress > 0.5;

      if (velocity >= FLICK_PX_PER_MS) {
        open = true;
      } else if (velocity <= -FLICK_PX_PER_MS) {
        open = false;
      }

      settle(open);
    };

    const capture = { capture: true };

    document.addEventListener('touchstart', onStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onMove, { capture: true, passive: false });
    document.addEventListener('touchend', onEnd, capture);
    document.addEventListener('touchcancel', onEnd, capture);

    return () => {
      window.clearTimeout(settleTimer);
      document.removeEventListener('touchstart', onStart, capture);
      document.removeEventListener('touchmove', onMove, capture);
      document.removeEventListener('touchend', onEnd, capture);
      document.removeEventListener('touchcancel', onEnd, capture);
      clearInline(true);
    };
  }, [scrimRef]);

  return { dragging, attachScrim };
}
