import { CalendarRange, ListTodo, Sparkles } from '@ci/shadcn/icons';
import { useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';

import { RailSubmenuHead, RailSubmenuRow, RailSubmenuShell } from './RailSubmenuShell';
import { useFeedBadgeCount } from './useFeedBadgeCount';
import { usePlanBadgeCount } from './usePlanBadgeCount';
import { useRailSubmenuOpen } from './useRailSubmenuOpen';

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
 * Power Rail Planning entry with three sub-views: Today, Tasks and Calendar.
 *
 * Static children, not a shared sections module — nothing else in the app
 * consumes a "Planning sections" list the way MemoryHubNav also consumes
 * MEMORY_HUB_SECTIONS.
 */
export function PlanningSubmenu() {
  const { pathname } = useLocation();
  const { isFeatureEnabled } = useFeatures();
  // Today lives outside /plan but hangs off this submenu, so its own route has
  // to hold the submenu open too — otherwise navigating to it collapses the
  // rail entry you navigated from.
  const routeOpen =
    pathname === '/plan' ||
    pathname.startsWith('/plan/') ||
    pathname === '/today' ||
    pathname.startsWith('/today/');
  const { open, clickOpen, onOpenChange, onHeadClick } = useRailSubmenuOpen('plan', routeOpen);

  const planBadgeCount = usePlanBadgeCount();
  const feedBadgeCount = useFeedBadgeCount();

  // The unseen-actions/summaries badge belongs to Today, the page that can
  // actually open them; it sat on Calendar, which cannot show either since the
  // brief cards were removed from it. `useFeedBadgeCount` returns 0 while
  // `today.page` is off, so this row's absence and its count agree.
  const sections: PlanningSection[] = [
    { to: '/today', label: 'Today', icon: Sparkles, flag: 'today.page', badgeCount: feedBadgeCount },
    { to: '/plan/tasks', label: 'Tasks', icon: ListTodo, flag: 'planning.page', badgeCount: planBadgeCount },
    { to: '/plan/calendar', label: 'Calendar', icon: CalendarRange, badgeCount: 0 },
  ];

  const visible = sections.filter((section) => !section.flag || isFeatureEnabled(section.flag));
  const combinedBadgeCount = visible.reduce((total, section) => total + section.badgeCount, 0);
  const planningIcon = <ListTodo className="h-6 w-6 shrink-0" strokeWidth={1.25} />;

  return (
    <RailSubmenuShell
      to="/plan"
      ariaLabel="Planning"
      chevronLabel="Planning"
      routeOpen={routeOpen}
      open={open}
      clickOpen={clickOpen}
      onOpenChange={onOpenChange}
      onHeadClick={onHeadClick}
      testId="planning-submenu"
      collapsedIcon={planningIcon}
      collapsedBadge={badgePill(combinedBadgeCount)}
      head={<RailSubmenuHead icon={planningIcon} label="Planning" badge={badgePill(combinedBadgeCount)} />}
    >
      {visible.map((section) => {
        const Icon = section.icon;
        const active = pathname === section.to || pathname.startsWith(`${section.to}/`);

        return (
          <RailSubmenuRow
            key={section.to}
            to={section.to}
            label={section.label}
            active={active}
            icon={<Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.25} />}
            badge={badgePill(section.badgeCount)}
          />
        );
      })}
    </RailSubmenuShell>
  );
}
