import { useState, useEffect } from 'react';

import { Collapsible, cn } from '@ci/shadcn';
import { CalendarRange, ChevronRight, ListTodo } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';

import { usePowerRail } from '../PowerRailContext';

import { NavLink } from './NavLink';
import { useFeedBadgeCount } from './useFeedBadgeCount';
import { usePlanBadgeCount } from './usePlanBadgeCount';

interface PlanningSection {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof ListTodo;
  readonly flag?: string;
  readonly badgeCount: number;
}

function badgePill(count: number) {
  if (count <= 0) {
    return null;
  }

  return (
    <span className="pointer-events-none ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * Power Rail Planning entry with two sub-views: Tasks and Calendar.
 *
 * Modeled on MemorySubmenu — same head-row-plus-chevron shape, same
 * sticky/hover/route-driven open state — but with two static children
 * instead of a shared sections module, since nothing else in the app
 * consumes a "Planning sections" list the way MemoryHubNav also consumes
 * MEMORY_HUB_SECTIONS.
 */
export function PlanningSubmenu() {
  const { expanded } = usePowerRail();
  const { pathname } = useLocation();
  const { isFeatureEnabled } = useFeatures();
  const [stickyOpen, setStickyOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  /** User closed via chevron — ignore hover/route until mouse leave or reopen. */
  const [dismissed, setDismissed] = useState(false);

  const planBadgeCount = usePlanBadgeCount();
  const feedBadgeCount = useFeedBadgeCount();

  const routeOpen = pathname.startsWith('/plan');
  const planningRootActive = pathname === '/plan';
  const open = dismissed ? false : stickyOpen || routeOpen || hoverOpen;

  const sections: PlanningSection[] = [
    { to: '/plan/tasks', label: 'Tasks', icon: ListTodo, flag: 'planning.page', badgeCount: planBadgeCount },
    { to: '/plan/calendar', label: 'Calendar', icon: CalendarRange, badgeCount: feedBadgeCount },
  ];

  const visible = sections.filter((section) => !section.flag || isFeatureEnabled(section.flag));
  const combinedBadgeCount = visible.reduce((total, section) => total + section.badgeCount, 0);

  // New hub page → allow auto-open again.
  useEffect(() => {
    setDismissed(false);
  }, [pathname]);

  if (!expanded) {
    return (
      <NavLink to="/plan" label="Planning" badgeCount={combinedBadgeCount}>
        <ListTodo className="h-6 w-6 shrink-0" strokeWidth={1.25} />
      </NavLink>
    );
  }

  return (
    <div
      data-testid="planning-submenu"
      className="min-w-0 w-full overflow-hidden"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => {
        setHoverOpen(false);
        setDismissed(false);
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
        {/* One row: Planning + chevron share the same box (same geometry as NavLink). */}
        <div
          className={cn(
            'flex min-w-0 w-full items-center rounded-md border-l-2 border-transparent',
            planningRootActive && 'border-l-primary text-primary',
          )}
        >
          <Link
            to="/plan"
            aria-label="Planning"
            aria-current={planningRootActive ? 'page' : undefined}
            onClick={() => {
              setStickyOpen(true);
              setDismissed(false);
            }}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-3 rounded-l-md px-2 py-2 transition hover:bg-accent hover:text-accent-foreground',
              planningRootActive && 'text-primary hover:text-primary',
            )}
          >
            <ListTodo className="h-6 w-6 shrink-0" strokeWidth={1.25} />
            <span className="truncate text-sm">Planning</span>
            {badgePill(combinedBadgeCount)}
          </Link>
          <Collapsible.Trigger
            className="flex shrink-0 items-center self-stretch rounded-r-md px-2 transition hover:bg-accent hover:text-accent-foreground [&[data-state=open]>svg]:rotate-90"
            aria-label={open ? 'Collapse Planning sections' : 'Expand Planning sections'}
          >
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform" />
          </Collapsible.Trigger>
        </div>

        <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="flex min-w-0 flex-col">
            {visible.map((section) => {
              const Icon = section.icon;
              const active = pathname === section.to || pathname.startsWith(`${section.to}/`);

              return (
                <Link
                  key={section.to}
                  to={section.to}
                  aria-label={section.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-1.5 text-sm leading-tight transition hover:bg-accent hover:text-accent-foreground',
                    active && 'border-l-primary text-primary hover:text-primary',
                  )}
                >
                  <span className="grid size-6 shrink-0 place-items-center" aria-hidden>
                    <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.25} />
                  </span>
                  <span className="truncate">{section.label}</span>
                  {badgePill(section.badgeCount)}
                </Link>
              );
            })}
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  );
}
