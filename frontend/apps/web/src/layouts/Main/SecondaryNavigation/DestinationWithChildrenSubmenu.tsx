import { useEffect, useState } from 'react';

import { Collapsible, Tooltip, cn } from '@ci/shadcn';
import { ChevronRight } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { usePowerRail } from '../PowerRailContext';
import { type RailDestination, isRailDestinationActive } from '../railDestinations';

/**
 * Any rail destination that carries `children` (currently: Saved Searches,
 * with Asks beside it — both a bounded search run as you, so two rows for
 * one primitive read as two unrelated places). Renders the head as its own
 * link plus a chevron that reveals the children as a compact group.
 *
 * Was `ChatSubmenu` — Chat itself moved under Memory (its recent threads went
 * with it, into `MemorySubmenu`), and this generic shell is what remained:
 * any destination with `children` uses it, not one hardcoded id at a time.
 *
 * Open rules match {@link MemorySubmenu}: sticky click, a route in the group,
 * or hover — unless the user closed it with the chevron.
 */
export function DestinationWithChildrenSubmenu({ destination }: { destination: RailDestination }) {
  const { expanded } = usePowerRail();
  const { pathname } = useLocation();
  const [stickyOpen, setStickyOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  /** User closed via chevron — ignore hover/route until mouse leave or reopen. */
  const [dismissed, setDismissed] = useState(false);

  const children = destination.children ?? [];
  const routeOpen =
    isRailDestinationActive(destination, pathname) ||
    children.some((child) => isRailDestinationActive(child, pathname));
  const rootActive = pathname === destination.to;
  const open = dismissed ? false : stickyOpen || routeOpen || hoverOpen;

  // New page in the group → allow auto-open again.
  useEffect(() => {
    setDismissed(false);
  }, [pathname]);

  const Icon = destination.icon;

  if (!expanded) {
    const collapsed = (
      <Link
        to={destination.to}
        aria-label={destination.label}
        className={cn(
          'relative rounded-md border-l-2 border-transparent p-2 transition hover:bg-accent hover:text-accent-foreground',
          routeOpen && 'border-l-primary text-primary hover:text-primary',
        )}
      >
        <Icon className="h-6 w-6 shrink-0" strokeWidth={1.25} />
      </Link>
    );

    return (
      <Tooltip>
        <Tooltip.Trigger asChild>{collapsed}</Tooltip.Trigger>
        <Tooltip.Content side="right">{destination.label}</Tooltip.Content>
      </Tooltip>
    );
  }

  return (
    <div
      data-testid={`${destination.id}-submenu`}
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
        {/* One row: the head + chevron share the same box (same geometry as NavLink). */}
        <div
          className={cn(
            'flex min-w-0 w-full items-center rounded-md border-l-2 border-transparent',
            rootActive && 'border-l-primary text-primary',
          )}
        >
          <Link
            to={destination.to}
            aria-label={destination.label}
            aria-current={rootActive ? 'page' : undefined}
            onClick={() => {
              setStickyOpen(true);
              setDismissed(false);
            }}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-3 rounded-l-md px-2 py-2 transition hover:bg-accent hover:text-accent-foreground',
              rootActive && 'text-primary hover:text-primary',
            )}
          >
            <Icon className="h-6 w-6 shrink-0" strokeWidth={1.25} />
            <span className="truncate text-sm">{destination.label}</span>
          </Link>
          <Collapsible.Trigger
            className="flex shrink-0 items-center self-stretch rounded-r-md px-2 transition hover:bg-accent hover:text-accent-foreground [&[data-state=open]>svg]:rotate-90"
            aria-label={
              open ? `Collapse ${destination.label} sections` : `Expand ${destination.label} sections`
            }
          >
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform" />
          </Collapsible.Trigger>
        </div>

        <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="flex min-w-0 flex-col">
            {children.map((child) => {
              const ChildIcon = child.icon;
              const active = isRailDestinationActive(child, pathname);

              return (
                <Link
                  key={child.id}
                  to={child.to}
                  aria-label={child.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-0 text-sm leading-tight transition hover:bg-accent hover:text-accent-foreground',
                    active && 'border-l-primary text-primary hover:text-primary',
                  )}
                >
                  <span className="grid size-6 shrink-0 place-items-center" aria-hidden>
                    <ChildIcon className="h-4 w-4 text-muted-foreground" strokeWidth={1.25} />
                  </span>
                  <span className="truncate">{child.label}</span>
                </Link>
              );
            })}
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  );
}
