import { CalendarRange, ListTodo } from '@ci/shadcn/icons';
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
 * Power Rail Planning entry with two sub-views: Tasks and Calendar.
 *
 * Static children, not a shared sections module — nothing else in the app
 * consumes a "Planning sections" list the way MemoryHubNav also consumes
 * MEMORY_HUB_SECTIONS.
 */
export function PlanningSubmenu() {
  const { pathname } = useLocation();
  const { isFeatureEnabled } = useFeatures();
  const routeOpen = pathname === '/plan' || pathname.startsWith('/plan/');
  const { open, onOpenChange, onHeadClick } = useRailSubmenuOpen('plan', routeOpen);

  const planBadgeCount = usePlanBadgeCount();
  const feedBadgeCount = useFeedBadgeCount();

  const sections: PlanningSection[] = [
    { to: '/plan/tasks', label: 'Tasks', icon: ListTodo, flag: 'planning.page', badgeCount: planBadgeCount },
    { to: '/plan/calendar', label: 'Calendar', icon: CalendarRange, badgeCount: feedBadgeCount },
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
