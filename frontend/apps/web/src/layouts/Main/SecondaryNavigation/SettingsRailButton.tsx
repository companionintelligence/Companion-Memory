import { useDeviceLayout } from '@ci/common';
import { Settings2 } from '@ci/shadcn/icons';
import { useLocation } from 'react-router-dom';

import { NavLink } from './NavLink';

/**
 * Settings as its own bottom-anchored rail row, below Self.
 *
 * It used to be reachable only two levels deep — inside the Self tile, behind
 * its chevron — with no icon at all in the collapsed rail. Desktop still opens
 * the same overlay dialog (a NavLink to `/settings/appearance` carrying
 * `state.backgroundLocation` so it portals over the page you were on rather
 * than a blank one); the phone still walks to the real `/self/settings` page.
 * This is the same destination NavUserMenu's own Settings row pointed at —
 * promoted out of the Self chevron, not a second path to a second place.
 */
export function SettingsRailButton() {
  const { isMobile } = useDeviceLayout();
  const location = useLocation();

  if (isMobile == null) {
    return null;
  }

  return (
    <NavLink
      to={isMobile ? '/self/settings' : '/settings/appearance'}
      state={isMobile ? undefined : { backgroundLocation: location }}
      label="Settings"
      end={false}
    >
      <Settings2 className="h-6 w-6 shrink-0" strokeWidth={1.25} />
    </NavLink>
  );
}
