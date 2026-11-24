import type { ComponentProps, ReactNode } from 'react';

import { Tooltip, cn } from '@ci/shadcn';
import { NavLink as BaseNavLink, useMatch, useResolvedPath } from 'react-router-dom';

import { usePowerRail } from '../PowerRailContext';

import { RAIL_COLLAPSED_BADGE, RAIL_SECTION_HEIGHT, RAIL_SECTION_INSET, railRowTone } from './railRow';

interface NavLinkProps extends ComponentProps<typeof BaseNavLink> {
  label: string;
  children: ReactNode;
  badgeCount?: number;
}

export function NavLink({ to, label, children, badgeCount = 0, className, ...props }: NavLinkProps) {
  const { expanded } = usePowerRail();
  const resolvedPath = useResolvedPath(to);

  const match = useMatch({
    path: resolvedPath.pathname,
    end: props.end,
  });

  const isActive = Boolean(match);

  const link = (
    <BaseNavLink
      to={to}
      aria-label={label}
      className={cn(
        'relative flex items-center rounded-md transition will-change-transform active:scale-95',
        RAIL_SECTION_HEIGHT,
        expanded ? ['gap-3', RAIL_SECTION_INSET] : 'justify-center',
        // A filled row, not a `border-l`: on a rounded row that border bent
        // round the corners into a "(".
        railRowTone(isActive),
        className,
      )}
      {...props}
    >
      {children}

      {expanded && <span className="truncate text-sm">{label}</span>}

      {badgeCount > 0 && (
        <span
          className={cn(
            'pointer-events-none inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground',
            // Collapsed, over the icon's top like every rail count — see
            // RAIL_COLLAPSED_BADGE for why it stays inside the cell.
            expanded ? 'ml-auto' : RAIL_COLLAPSED_BADGE,
          )}
        >
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      )}
    </BaseNavLink>
  );

  // Visible labels make the tooltip redundant — and a bubble on every row
  // fights the expanded rail.
  if (expanded) {
    return link;
  }

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>{link}</Tooltip.Trigger>
      <Tooltip.Content side="right">{label}</Tooltip.Content>
    </Tooltip>
  );
}
