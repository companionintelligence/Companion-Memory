import { useEffect, useState } from 'react';

import { useLocation } from 'react-router-dom';

import { usePowerRail } from '../PowerRailContext';

/**
 * Shared open rules for every Power Rail submenu.
 *
 * Hover, chevron pin, and the current route can each open a group — but only
 * one group at a time. Hovering Jobs must close Planning, not stack a second
 * accordion under it. Leaving the rail (see {@link usePowerRail} setHovered)
 * clears hover so a route-open group can return.
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
  const { hoveredSubmenuId, setHoveredSubmenuId, stickySubmenuId, setStickySubmenuId } = usePowerRail();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [pathname]);

  const hoverOpen = hoveredSubmenuId === id;
  const stickyOpen = stickySubmenuId === id;
  const peerHovered = hoveredSubmenuId !== null && hoveredSubmenuId !== id;
  const peerSticky = hoveredSubmenuId === null && stickySubmenuId !== null && stickySubmenuId !== id;
  const open = !dismissed && !peerHovered && (hoverOpen || stickyOpen || (!peerSticky && routeOpen));

  const onMouseEnter = () => {
    if (dismissed) {
      return;
    }

    setHoveredSubmenuId(id);
  };

  const onMouseLeave = () => {
    setHoveredSubmenuId(hoveredSubmenuId === id ? null : hoveredSubmenuId);
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

  return { open, onMouseEnter, onMouseLeave, onOpenChange, onHeadClick };
}
