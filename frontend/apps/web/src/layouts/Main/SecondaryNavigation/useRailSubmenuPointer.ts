import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import { NO_SUBMENUS, usePowerRail } from '../PowerRailContext';

/** Marks a rail submenu's outer element; the value is its submenu id. */
export const RAIL_SUBMENU_ATTR = 'data-rail-submenu';

function submenuAt(element: Element | null): string | null {
  return element?.closest<HTMLElement>(`[${RAIL_SUBMENU_ATTR}]`)?.getAttribute(RAIL_SUBMENU_ATTR) ?? null;
}

/**
 * The open groups that sit above `id` in the rail, in DOM order.
 *
 * Opening a group only pushes rows *down*, away from the pointer on its head.
 * Closing a group above the pointer pulls every row *up* under it — the
 * pointer ends up below everything it was reaching for. So a group above
 * the one just entered stays open until the pointer leaves the rail; groups
 * below it close, because nothing under the pointer moves when they do.
 */
function openSubmenusAbove(rail: HTMLElement, id: string): readonly string[] {
  const held: string[] = [];

  for (const group of rail.querySelectorAll<HTMLElement>(`[${RAIL_SUBMENU_ATTR}]`)) {
    const groupId = group.getAttribute(RAIL_SUBMENU_ATTR);

    if (groupId === id) {
      break;
    }

    if (groupId !== null && group.dataset.state === 'open') {
      held.push(groupId);
    }
  }

  return held.length === 0 ? NO_SUBMENUS : held;
}

/**
 * Which submenu the pointer *travelled into* — as opposed to which one
 * happens to be under it.
 *
 * Those differ the moment an accordion opens or closes: the rows below it
 * jump, a different group lands under a pointer that never moved, and the
 * browser fires mouseenter for it anyway. Acting on that opens the new group,
 * which closes the old one, which jumps the rows again — the rail flaps
 * between sections until the pointer leaves. So enter/leave events are not
 * the signal here.
 *
 * Instead, every pointermove hit-tests both its own position and the
 * previous position **in the current layout**. A transition happens only
 * when the two straddle a group boundary — i.e. the pointer actually crossed
 * it. A layout change alone hit-tests both points into the same group and
 * changes nothing; the group opens (or stays open) until the pointer moves
 * across a boundary or leaves the rail. Entering a group keeps the open
 * groups above it open too ({@link openSubmenusAbove}) — the one-group rule
 * holds again once the pointer leaves.
 *
 * Attach the handlers to the rail's outermost hover surface.
 */
export function useRailSubmenuPointer() {
  const { setHoveredSubmenuId, setHeldOpenSubmenuIds } = usePowerRail();
  const last = useRef<{ x: number; y: number; submenuId: string | null } | null>(null);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch') {
        return;
      }

      const current = submenuAt(event.target as Element);
      const previous = last.current;
      last.current = { x: event.clientX, y: event.clientY, submenuId: current };

      if (current === null) {
        // Left a group for rail chrome (Capture, Settings, the gaps). Nothing
        // collapses until the pointer leaves the rail — collapsing now would
        // move rows under it, which is the flap we are here to stop.
        return;
      }

      let previousNow: string | null = null;

      if (previous) {
        // jsdom has no layout, so it has no elementFromPoint; the last
        // event's own answer is the best it can do there.
        previousNow =
          typeof document.elementFromPoint === 'function'
            ? submenuAt(document.elementFromPoint(previous.x, previous.y))
            : previous.submenuId;
      }

      if (current !== previousNow) {
        setHeldOpenSubmenuIds(openSubmenusAbove(event.currentTarget, current));
        setHoveredSubmenuId(current);
      }
    },
    [setHoveredSubmenuId, setHeldOpenSubmenuIds],
  );

  const onPointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch') {
        return;
      }

      last.current = null;
      setHoveredSubmenuId(null);
      setHeldOpenSubmenuIds(NO_SUBMENUS);
    },
    [setHoveredSubmenuId, setHeldOpenSubmenuIds],
  );

  return { onPointerMove, onPointerLeave };
}
