import type { ComponentProps, ReactNode } from 'react';

import { Tooltip, cn } from '@ci/shadcn';
import { NavLink as BaseNavLink, useMatch, useResolvedPath } from 'react-router-dom';

interface NavLinkProps extends ComponentProps<typeof BaseNavLink> {
  label: string;
  children: ReactNode;
  badgeCount?: number;
}

export function NavLink({ to, label, children, badgeCount = 0, ...props }: NavLinkProps) {
  const resolvedPath = useResolvedPath(to);

  const match = useMatch({
    path: resolvedPath.pathname,
    end: props.end,
  });

  const isActive = Boolean(match);

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>
        <BaseNavLink
          to={to}
          aria-label={label}
          className={cn(
            'relative border-l-2 border-transparent p-2 rounded-md hover:bg-accent hover:text-accent-foreground transition will-change-transform active:scale-95',
            isActive &&
              'border-l-[#58ebbf] text-[#58ebbf] shadow-glow-ci hover:bg-accent hover:text-[#58ebbf]',
          )}
          {...props}
        >
          {children}

          {badgeCount > 0 && (
            <span className="pointer-events-none absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )}
        </BaseNavLink>
      </Tooltip.Trigger>
      <Tooltip.Content side="right">{label}</Tooltip.Content>
    </Tooltip>
  );
}
