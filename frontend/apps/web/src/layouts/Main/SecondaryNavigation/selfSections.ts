import type { ComponentType } from 'react';

import { ChartColumn, NotebookPen, Settings2, UserRound } from '@ci/shadcn/icons';

export type SelfSectionIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

export type SelfSection = {
  to: string;
  label: string;
  match: (path: string) => boolean;
  flag?: string;
  icon: SelfSectionIcon;
};

/**
 * Self destinations — the Power Rail Self submenu's sub-items. Account
 * deletion/credentials live at the bottom of Profile rather than as their own
 * destination — one identity surface, not two.
 *
 * Settings sits here with Profile / Stats / Reflections, not as its own
 * bottom-anchored rail row. Desktop still opens the overlay dialog
 * (`/settings/appearance` + `backgroundLocation`); the phone walks to the
 * real `/self/settings` page. See {@link settingsNavTarget}.
 */
export const SELF_SECTIONS: SelfSection[] = [
  { to: '/self', label: 'Profile', match: (p) => p === '/self', icon: UserRound },
  {
    to: '/self/stats',
    label: 'Stats',
    match: (p) => p === '/self/stats',
    // What `stats.page` was always named for. It used to gate the whole Self
    // tile instead, which took Settings and Log out with it.
    flag: 'stats.page',
    icon: ChartColumn,
  },
  {
    to: '/self/reflections',
    label: 'Reflections',
    match: (p) => p === '/self/reflections',
    flag: 'insights.page',
    icon: NotebookPen,
  },
  {
    to: '/self/settings',
    label: 'Settings',
    match: isSettingsPath,
    icon: Settings2,
  },
];

export function isSettingsPath(pathname: string): boolean {
  return (
    pathname === '/self/settings' ||
    pathname.startsWith('/self/settings/') ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/')
  );
}

export function isSelfPath(pathname: string): boolean {
  return pathname === '/self' || pathname.startsWith('/self/') || isSettingsPath(pathname);
}

/**
 * Where the Settings row actually goes.
 *
 * Returns null until the device layout is known, so the rail does not flash
 * the desktop overlay destination on a phone (or the other way around).
 */
export function settingsNavTarget(
  isMobile: boolean | undefined,
  location: { pathname: string; search: string; hash: string; state: unknown; key: string },
): { to: string; state?: { backgroundLocation: typeof location } } | null {
  if (isMobile == null) {
    return null;
  }

  if (isMobile) {
    return { to: '/self/settings' };
  }

  return { to: '/settings/appearance', state: { backgroundLocation: location } };
}

/**
 * A link to one Settings section from anywhere in the app.
 *
 * Same split as {@link settingsNavTarget}: the phone walks to the real
 * `/self/settings/<section>` page, desktop opens the overlay with the current
 * page kept behind it, so closing Settings returns to where the link was.
 */
export function settingsSectionTarget(
  section: string,
  isMobile: boolean | undefined,
  location: { pathname: string; search: string; hash: string; state: unknown; key: string },
): { to: string; state?: { backgroundLocation: typeof location } } | null {
  if (isMobile == null) {
    return null;
  }

  if (isMobile) {
    return { to: `/self/settings/${section}` };
  }

  return { to: `/settings/${section}`, state: { backgroundLocation: location } };
}
