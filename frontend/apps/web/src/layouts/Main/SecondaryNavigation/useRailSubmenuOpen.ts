import { useEffect, useState } from 'react';

import { useLocation } from 'react-router-dom';

import { usePowerRail } from '../PowerRailContext';

/**
 * Shared open rules for every Power Rail submenu.
 *
 * Exactly one group is open at a time: clicking a chevron (or a group's own
 * head link) opens that group and closes any other — see `openSubmenuId` on
 * {@link usePowerRail}. The current route can also open a group on its own,
 * but a click always wins over route-driven opens for whichever group isn't
 * the one clicked.
 *
 * A chevron close stays closed — even on that group's own route — until the
 * route changes or the group is clicked open again.
 *
 * `clickOpen` is the click-driven half only. The collapsed rail uses it so
 * merely *being* on the group's route does not pin a stack of child icons
 * open while the rail stays narrow.
 */
export function useRailSubmenuOpen(id: string, routeOpen: boolean) {
  const { pathname } = useLocation();
  const { openSubmenuId, setOpenSubmenuId } = usePowerRail();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [pathname]);

  const isOpenSubmenu = openSubmenuId === id;
  const peerOpen = openSubmenuId !== null && openSubmenuId !== id;
  const open = !dismissed && !peerOpen && (isOpenSubmenu || routeOpen);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setOpenSubmenuId(id);
      setDismissed(false);
    } else {
      setOpenSubmenuId((current) => (current === id ? null : current));
      setDismissed(true);
    }
  };

  const onHeadClick = () => {
    setOpenSubmenuId(id);
    setDismissed(false);
  };

  return { open, clickOpen: isOpenSubmenu, onOpenChange, onHeadClick };
}
