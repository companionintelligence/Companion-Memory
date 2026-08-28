import { useEffect, useMemo, useState } from 'react';

import { Collapsible, Tooltip, cn } from '@ci/shadcn';
import { ChevronRight } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { PersonAvatar } from '@/components/PersonAvatar';
import { useCurrentUser } from '@/hooks';

import { NavUserMenu } from '../PrimaryNavigation/NavUser';
import { usePowerRail } from '../PowerRailContext';

import { SELF_SECTIONS, isSelfPath } from './selfSections';

/**
 * Self is the user-info tile — avatar, name, email — not a "Self" label.
 * Same open rules as {@link MemorySubmenu}: sticky click, self route, or
 * hover, unless the user closed it (chevron).
 */
export function SelfSubmenu() {
  const { expanded } = usePowerRail();
  const { pathname } = useLocation();
  const { isFeatureEnabled } = useFeatures();
  const { user } = useCurrentUser();
  const [stickyOpen, setStickyOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  /** User closed via chevron — stay closed until they reopen, even on a Self route. */
  const [dismissed, setDismissed] = useState(false);

  const currentUser = useMemo(
    () => ({
      name: user?.name || user?.email || 'User',
      email: user?.email || '',
      avatarUrl: user?.avatarUrl,
    }),
    [user],
  );

  const routeOpen = isSelfPath(pathname);
  const open = dismissed ? false : stickyOpen || routeOpen || hoverOpen;
  const visible = SELF_SECTIONS.filter((section) => !section.flag || isFeatureEnabled(section.flag));
  const avatar = <PersonAvatar name={currentUser.name} avatarUrl={currentUser.avatarUrl} size="sm" />;

  useEffect(() => {
    setDismissed(false);
  }, [pathname]);

  if (!expanded) {
    const collapsed = (
      <Link
        to="/self"
        aria-label={currentUser.name}
        className={cn(
          'relative flex items-center justify-center rounded-md border-l-2 border-transparent p-1 transition hover:bg-accent',
          routeOpen && 'border-l-primary text-primary hover:text-primary',
        )}
      >
        {avatar}
      </Link>
    );

    return (
      <Tooltip delayDuration={600}>
        <Tooltip.Trigger asChild>{collapsed}</Tooltip.Trigger>
        <Tooltip.Content side="right">{currentUser.name}</Tooltip.Content>
      </Tooltip>
    );
  }

  return (
    <div
      data-testid="self-submenu"
      className="min-w-0 w-full overflow-hidden"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => {
        setHoverOpen(false);
      }}
    >
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setStickyOpen(true);
            setDismissed(false);
          } else {
            setStickyOpen(false);
            setDismissed(true);
          }
        }}
        className="min-w-0 w-full"
      >
        <div
          className={cn(
            'flex min-w-0 w-full items-center rounded-md border-l-2 border-transparent',
            routeOpen && pathname === '/self' && 'border-l-primary',
          )}
        >
          <Link
            to="/self"
            aria-label={currentUser.name}
            aria-current={pathname === '/self' ? 'page' : undefined}
            onClick={() => {
              setStickyOpen(true);
              setDismissed(false);
            }}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-l-md px-2 py-1.5 transition hover:bg-accent hover:text-accent-foreground"
          >
            {avatar}
            <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{currentUser.name}</span>
              <span className="truncate text-xs text-muted-foreground">{currentUser.email}</span>
            </span>
          </Link>
          <Collapsible.Trigger
            className="flex shrink-0 items-center self-stretch rounded-r-md px-2 transition hover:bg-accent hover:text-accent-foreground [&[data-state=open]>svg]:rotate-90"
            aria-label={open ? 'Collapse Self sections' : 'Expand Self sections'}
          >
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform" />
          </Collapsible.Trigger>
        </div>

        <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="flex min-w-0 flex-col">
            {visible.map((section) => {
              const Icon = section.icon;
              const active = section.match(pathname);

              return (
                <Link
                  key={section.to}
                  to={section.to}
                  aria-label={section.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-0 text-sm leading-tight transition hover:bg-accent hover:text-accent-foreground',
                    active && 'border-l-primary text-primary hover:text-primary',
                  )}
                >
                  <span className="grid size-6 shrink-0 place-items-center" aria-hidden>
                    <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.25} />
                  </span>
                  <span className="truncate">{section.label}</span>
                </Link>
              );
            })}

            <NavUserMenu />
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  );
}
