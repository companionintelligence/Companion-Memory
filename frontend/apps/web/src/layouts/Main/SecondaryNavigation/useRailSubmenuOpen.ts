import { useEffect, useState } from 'react';

import { useLocation } from 'react-router-dom';

import { usePowerRail } from '../PowerRailContext';

import { RAIL_SUBMENU_ATTR } from './useRailSubmenuPointer';

/**
 * Shared open rules for every Power Rail submenu.
 *
 * Hover, chevron pin, and the current route can each open a group — one at a
 * time, with one exception. Hovering Jobs closes Self below it, but keeps an
 * open Planning above it: closing a group above the pointer drags every row
 * up under the cursor, so the pointer lands below what it was reaching for.
 * Those groups are "held" ({@link useRailSubmenuPointer}) until the pointer
 * leaves the rail, and the one-group rule holds again from there.
 *
 * "Hovered" is decided for the whole rail by {@link useRailSubmenuPointer},
 * from pointer travel across group boundaries, and it is cleared only when
 * the pointer leaves the rail (see {@link usePowerRail} setHovered). Leaving
 * a group for the gap below it changes nothing: collapsing there would jump
 * the rows under a pointer that is still in the rail, and the group that
 * landed under it would open next — the flapping loop this replaces.
 *
 * `persistDismissedOnLeave` is Self's rule: a chevron close stays closed
 * through leave and a later enter, until the path changes or they reopen.
 * Planning / Memory / Jobs clear dismiss on leave so hover can try again.
 */
export function useRailSubmenuOpen(
  id: string,
  routeOpen: boolean,
  { persistDismissedOnLeave = false }: { persistDismissedOnLeave?: boolean } = {},
) {
  const { pathname } = useLocation();
  const { hoveredSubmenuId, setHoveredSubmenuId, heldOpenSubmenuIds, stickySubmenuId, setStickySubmenuId } =
    usePowerRail();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [pathname]);

  const hoverOpen = hoveredSubmenuId === id;
  const heldOpen = heldOpenSubmenuIds.includes(id);
  const stickyOpen = stickySubmenuId === id;
  const peerHovered = hoveredSubmenuId !== null && hoveredSubmenuId !== id;
  const peerSticky = hoveredSubmenuId === null && stickySubmenuId !== null && stickySubmenuId !== id;
  const open =
    !dismissed && (hoverOpen || heldOpen || (!peerHovered && (stickyOpen || (!peerSticky && routeOpen))));

  const onMouseLeave = () => {
    if (!persistDismissedOnLeave) {
      setDismissed(false);
    }
  };

  const onOpenChange = (next: boolean) => {
    if (next) {
      setStickySubmenuId(id);
      setHoveredSubmenuId(id);
      setDismissed(false);
    } else {
      setStickySubmenuId(stickySubmenuId === id ? null : stickySubmenuId);
      setHoveredSubmenuId(hoveredSubmenuId === id ? null : hoveredSubmenuId);
      setDismissed(true);
    }
  };

  const onHeadClick = () => {
    setStickySubmenuId(id);
    setHoveredSubmenuId(id);
    setDismissed(false);
  };

  /**
   * Spread onto the submenu's outer element so the rail can hit-test it and
   * read whether it is open (which decides what gets held on the next hover).
   */
  const groupProps = { [RAIL_SUBMENU_ATTR]: id, 'data-state': open ? 'open' : 'closed', onMouseLeave };

  return { open, groupProps, onOpenChange, onHeadClick };
}
