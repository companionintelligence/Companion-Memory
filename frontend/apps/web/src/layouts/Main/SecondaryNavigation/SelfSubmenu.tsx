import { useMemo } from 'react';

import { useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { PersonAvatar } from '@/components/PersonAvatar';
import { useCurrentUser } from '@/hooks';

import { NavUserMenu } from '../PrimaryNavigation/NavUser';

import { RailSubmenuRow, RailSubmenuShell } from './RailSubmenuShell';
import { SELF_SECTIONS, isSelfPath } from './selfSections';
import { useRailSubmenuOpen } from './useRailSubmenuOpen';

/**
 * Self is the user-info tile — avatar, name, email — not a "Self" label.
 * Same exclusive open rules as the other rail groups
 * ({@link useRailSubmenuOpen}). A chevron close stays closed until the route
 * changes or the tile is clicked open again.
 */
export function SelfSubmenu() {
  const { pathname } = useLocation();
  const { isFeatureEnabled } = useFeatures();
  const { user } = useCurrentUser();
  const routeOpen = isSelfPath(pathname);
  const { open, onOpenChange, onHeadClick } = useRailSubmenuOpen('self', routeOpen);

  const currentUser = useMemo(
    () => ({
      name: user?.name || user?.email || 'User',
      email: user?.email || '',
      avatarUrl: user?.avatarUrl,
    }),
    [user],
  );

  const visible = SELF_SECTIONS.filter((section) => !section.flag || isFeatureEnabled(section.flag));
  const avatar = <PersonAvatar name={currentUser.name} avatarUrl={currentUser.avatarUrl} size="sm" />;

  return (
    <RailSubmenuShell
      to="/self"
      ariaLabel={currentUser.name}
      chevronLabel="Self"
      routeOpen={routeOpen}
      open={open}
      onOpenChange={onOpenChange}
      onHeadClick={onHeadClick}
      testId="self-submenu"
      compactHead
      collapsedIcon={avatar}
      head={
        <>
          {avatar}
          <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{currentUser.name}</span>
            <span className="truncate text-xs text-muted-foreground">{currentUser.email}</span>
          </span>
        </>
      }
      footer={<NavUserMenu />}
    >
      {visible.map((section) => {
        const Icon = section.icon;
        const active = section.match(pathname);

        return (
          <RailSubmenuRow
            key={section.to}
            to={section.to}
            label={section.label}
            active={active}
            icon={<Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.25} />}
          />
        );
      })}
    </RailSubmenuShell>
  );
}
