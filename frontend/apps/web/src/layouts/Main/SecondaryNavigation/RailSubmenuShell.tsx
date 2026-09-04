import { type ReactNode } from 'react';

import { Collapsible, Popover, Tooltip, cn } from '@ci/shadcn';
import { ChevronRight } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { usePowerRail } from '../PowerRailContext';

/**
 * One shared shape for every Power Rail group — Planning, Memory, Self, and
 * any destination carrying `children` (Saved Searches, Jobs). Owns the
 * collapsed icon+tooltip, the head row, the chevron, and the expand/collapse
 * animation, so the four groups can only ever drift in their DATA (sections,
 * icons, badges), never in how they open, close, or look doing it.
 *
 * Collapsed, a head click still opens the group's children — as a flyout to
 * the right of the icon, so the rail lane never widens and the page beside it
 * never reflows. Expanded keeps the in-rail chevron accordion.
 *
 * Open/close state itself stays with the caller (via {@link useRailSubmenuOpen}),
 * not this component — a couple of callers (Memory, for its recent-threads
 * fetch) need `open` for more than rendering, and a second internal call to
 * that hook here would be a second, divergent source of truth for it.
 */
export interface RailSubmenuShellProps {
  to: string;
  /** Accessible name for the head link and the collapsed tooltip. */
  ariaLabel: string;
  /** Feeds the chevron's "Expand X sections" / "Collapse X sections" label. */
  chevronLabel: string;
  /** Whether the current route belongs to this group — highlights the collapsed icon. */
  routeOpen: boolean;
  open: boolean;
  /**
   * Click-driven open only. Collapsed flyouts use this so a matching route
   * does not keep a popover open while the rail stays narrow.
   */
  clickOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onHeadClick: () => void;
  collapsedIcon: ReactNode;
  collapsedBadge?: ReactNode;
  /** Full head-row content: icon + label (+ badge), or Self's avatar tile. */
  head: ReactNode;
  /** Self's two-line avatar tile is shorter than the standard icon+label row. */
  compactHead?: boolean;
  testId: string;
  /** Appended after `children`, inside the same collapsible content (Self's NavUserMenu). */
  footer?: ReactNode;
  children: ReactNode;
}

export function RailSubmenuShell({
  to,
  ariaLabel,
  chevronLabel,
  routeOpen,
  open,
  clickOpen,
  onOpenChange,
  onHeadClick,
  collapsedIcon,
  collapsedBadge,
  head,
  compactHead = false,
  testId,
  footer,
  children,
}: RailSubmenuShellProps) {
  const { expanded } = usePowerRail();
  const { pathname } = useLocation();
  const rootActive = pathname === to;

  if (!expanded) {
    const collapsed = (
      <Link
        to={to}
        aria-label={ariaLabel}
        aria-expanded={clickOpen}
        onClick={onHeadClick}
        className={cn(
          'relative flex items-center justify-center rounded-md border-l-2 border-transparent p-2 transition hover:bg-accent hover:text-accent-foreground',
          routeOpen && 'border-l-primary text-primary hover:text-primary',
        )}
      >
        {collapsedIcon}
        {collapsedBadge}
      </Link>
    );

    return (
      <Popover open={clickOpen} onOpenChange={onOpenChange}>
        <Popover.Anchor asChild>
          <div data-testid={testId} className="relative">
            {clickOpen ? (
              collapsed
            ) : (
              <Tooltip delayDuration={600}>
                <Tooltip.Trigger asChild>{collapsed}</Tooltip.Trigger>
                <Tooltip.Content side="right">{ariaLabel}</Tooltip.Content>
              </Tooltip>
            )}
          </div>
        </Popover.Anchor>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={8}
          className="w-56 p-1"
          onClick={(event) => {
            // Picking a child is the whole point of the flyout — close it so
            // the page is not covered by a menu the user already acted on.
            if ((event.target as HTMLElement).closest('a')) {
              onOpenChange(false);
            }
          }}
        >
          <div className="flex min-w-0 flex-col">
            {children}
            {footer}
          </div>
        </Popover.Content>
      </Popover>
    );
  }

  return (
    <div data-testid={testId} className="min-w-0 w-full overflow-hidden">
      <Collapsible open={open} onOpenChange={onOpenChange} className="min-w-0 w-full">
        {/* One row: the head + chevron share the same box (same geometry as NavLink). */}
        <div
          className={cn(
            'flex min-w-0 w-full items-center rounded-md border-l-2 border-transparent',
            rootActive && 'border-l-primary text-primary',
          )}
        >
          <Link
            to={to}
            aria-label={ariaLabel}
            aria-current={rootActive ? 'page' : undefined}
            onClick={onHeadClick}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-3 rounded-l-md px-2 transition hover:bg-accent hover:text-accent-foreground',
              compactHead ? 'py-1.5' : 'py-2',
              rootActive && 'text-primary hover:text-primary',
            )}
          >
            {head}
          </Link>
          <Collapsible.Trigger
            className="flex shrink-0 items-center self-stretch rounded-r-md px-2 transition hover:bg-accent hover:text-accent-foreground [&[data-state=open]>svg]:rotate-90"
            aria-label={open ? `Collapse ${chevronLabel} sections` : `Expand ${chevronLabel} sections`}
          >
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200" />
          </Collapsible.Trigger>
        </div>

        <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="flex min-w-0 flex-col">
            {children}
            {footer}
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  );
}

/** Standard icon + label (+ badge) head row — everything but Self's avatar tile. */
export function RailSubmenuHead({
  icon,
  label,
  badge,
}: {
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
}) {
  return (
    <>
      {icon}
      <span className="truncate text-sm">{label}</span>
      {badge}
    </>
  );
}

/** One child row inside an opened group — same shape for every submenu, including nested rows (e.g. Memory's recent threads). */
export function RailSubmenuRow({
  to,
  label,
  active,
  icon,
  badge,
}: {
  to: string;
  label: string;
  active: boolean;
  icon: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-0 text-sm leading-tight transition hover:bg-accent hover:text-accent-foreground',
        active && 'border-l-primary text-primary hover:text-primary',
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center" aria-hidden>
        {icon}
      </span>
      <span className="truncate">{label}</span>
      {badge}
    </Link>
  );
}
