import { type ReactNode } from 'react';

import { Collapsible, Tooltip, cn } from '@ci/shadcn';
import { ChevronRight } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { usePowerRail } from '../PowerRailContext';

import {
  RAIL_ACCOUNT_HEIGHT,
  RAIL_CHILD_HEIGHT,
  RAIL_CHILD_INSET,
  RAIL_COLLAPSED_BADGE,
  RAIL_ICON_ACTIVE,
  RAIL_LEAF_HEIGHT,
  RAIL_LEAF_INSET,
  RAIL_SECTION_HEIGHT,
  RAIL_SECTION_INSET,
  RailChildren,
  RailIndentedRow,
  railRowTone,
} from './railRow';

/**
 * One shared shape for every Power Rail group — Planning, Memory, Self, and
 * any destination carrying `children` (Saved Searches, Jobs). Owns the
 * collapsed icon+tooltip, the head row, the chevron, and the expand/collapse
 * animation, so the four groups can only ever drift in their DATA (sections,
 * icons, badges), never in how they open, close, or look doing it.
 *
 * Collapsed, a head click still opens the group's children — in the same
 * rail lane, icons only, at the same row heights as the expanded accordion,
 * so pinning the rail open never moves an icon. The page beside it never
 * reflows. Expanded keeps labels and the chevron, and hangs the children off
 * a guide line under the head's icon ({@link RailChildren}).
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
   * Click-driven open only. The collapsed rail uses this so merely *being*
   * on the group's route does not pin a stack of child icons open.
   */
  clickOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onHeadClick: () => void;
  collapsedIcon: ReactNode;
  collapsedBadge?: ReactNode;
  /** Full head-row content: icon + label (+ badge), or Self's avatar tile. */
  head: ReactNode;
  /**
   * Self's two-line avatar tile: a taller row than a section, with the wider
   * avatar centred on the icon column instead of starting on it.
   */
  accountHead?: boolean;
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
  accountHead = false,
  testId,
  footer,
  children,
}: RailSubmenuShellProps) {
  const { expanded } = usePowerRail();
  const { pathname } = useLocation();
  const rootActive = pathname === to;
  // The current page's fill is on the row box, so each half hovers over it.
  const headHover = rootActive
    ? 'hover:bg-primary/10 hover:text-primary'
    : 'hover:bg-accent hover:text-accent-foreground';

  if (!expanded) {
    const collapsed = (
      <Link
        to={to}
        aria-label={ariaLabel}
        aria-expanded={clickOpen}
        onClick={onHeadClick}
        // Same height as the expanded head, so pinning the rail open never
        // moves an icon; the group you are in is a filled cell.
        className={cn(
          'relative flex items-center justify-center rounded-md transition',
          accountHead ? RAIL_ACCOUNT_HEIGHT : RAIL_SECTION_HEIGHT,
          railRowTone(routeOpen),
        )}
      >
        {collapsedIcon}
        {collapsedBadge ? <span className={RAIL_COLLAPSED_BADGE}>{collapsedBadge}</span> : null}
      </Link>
    );

    return (
      <div data-testid={testId} className="min-w-0 w-full overflow-hidden">
        <Collapsible open={clickOpen} onOpenChange={onOpenChange} className="min-w-0 w-full">
          {clickOpen ? (
            collapsed
          ) : (
            <Tooltip delayDuration={600}>
              <Tooltip.Trigger asChild>{collapsed}</Tooltip.Trigger>
              <Tooltip.Content side="right">{ariaLabel}</Tooltip.Content>
            </Tooltip>
          )}

          <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
            <div className="flex min-w-0 flex-col gap-0.5">
              {children}
              {footer}
            </div>
          </Collapsible.Content>
        </Collapsible>
      </div>
    );
  }

  return (
    <div data-testid={testId} className="min-w-0 w-full overflow-hidden">
      <Collapsible open={open} onOpenChange={onOpenChange} className="min-w-0 w-full">
        {/* One row: the head + chevron share the same box (same geometry as
            NavLink). The current page fills the whole box, so the link and
            the chevron read as one row; each still hovers on its own. */}
        <div
          className={cn(
            'flex min-w-0 w-full items-stretch rounded-md',
            accountHead ? RAIL_ACCOUNT_HEIGHT : RAIL_SECTION_HEIGHT,
            rootActive && 'bg-primary/10 text-primary',
          )}
        >
          <Link
            to={to}
            aria-label={ariaLabel}
            aria-current={rootActive ? 'page' : undefined}
            onClick={onHeadClick}
            className={cn(
              'flex min-w-0 flex-1 items-center rounded-l-md transition',
              // The avatar is wider than an icon, so the account row centres it
              // on the icon column and closes the gap: the name then starts on
              // the same label column as every section above it.
              accountHead ? 'gap-2 py-1 pl-1.5 pr-2' : ['gap-3', RAIL_SECTION_INSET],
              headHover,
            )}
          >
            {head}
          </Link>
          <Collapsible.Trigger
            className={cn(
              'flex shrink-0 items-center rounded-r-md px-2 transition [&[data-state=open]>svg]:rotate-90',
              headHover,
            )}
            aria-label={open ? `Collapse ${chevronLabel} sections` : `Expand ${chevronLabel} sections`}
          >
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200" />
          </Collapsible.Trigger>
        </div>

        <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <RailChildren>
            {children}
            {footer}
          </RailChildren>
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

/**
 * One child row inside an opened group — the same shape for every submenu.
 *
 * Expanded, it starts just past the group's guide line with its icon, and the
 * current page carries the bar on the group's guide line. Collapsed, it is an
 * icon in the rail lane with its label in a tooltip.
 */
export function RailSubmenuRow({
  to,
  label,
  active,
  icon,
  badge,
  state,
}: {
  to: string;
  label: string;
  active: boolean;
  icon: ReactNode;
  badge?: ReactNode;
  state?: unknown;
}) {
  const { expanded } = usePowerRail();

  if (expanded) {
    return (
      <RailIndentedRow active={active}>
        <Link
          to={to}
          state={state}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-md text-sm transition',
            RAIL_CHILD_HEIGHT,
            RAIL_CHILD_INSET,
            railRowTone(active),
          )}
        >
          <span
            className={cn('grid size-4 shrink-0 place-items-center', active && RAIL_ICON_ACTIVE)}
            aria-hidden
          >
            {icon}
          </span>
          <span className="truncate">{label}</span>
          {badge}
        </Link>
      </RailIndentedRow>
    );
  }

  return (
    <Tooltip delayDuration={600}>
      <Tooltip.Trigger asChild>
        <Link
          to={to}
          state={state}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative flex min-w-0 items-center justify-center rounded-md transition',
            RAIL_CHILD_HEIGHT,
            railRowTone(active),
          )}
        >
          <span
            className={cn('grid size-6 shrink-0 place-items-center', active && RAIL_ICON_ACTIVE)}
            aria-hidden
          >
            {icon}
          </span>
          {badge ? <span className={RAIL_COLLAPSED_BADGE}>{badge}</span> : null}
        </Link>
      </Tooltip.Trigger>
      <Tooltip.Content side="right">{label}</Tooltip.Content>
    </Tooltip>
  );
}

/**
 * A row one level below a child — Chat's recent threads under Memory → Chat.
 *
 * Text only, smaller and muted, and indented again so three levels read as
 * three levels instead of one long list. Labels only, so it has no collapsed
 * form: the icon rail never shows this level.
 */
export function RailSubmenuLeaf({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <RailIndentedRow active={active}>
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex min-w-0 items-center rounded-md text-xs transition',
          RAIL_LEAF_HEIGHT,
          RAIL_LEAF_INSET,
          !active && 'text-muted-foreground',
          railRowTone(active),
        )}
      >
        <span className="truncate">{label}</span>
      </Link>
    </RailIndentedRow>
  );
}
