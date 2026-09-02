import { useLocation } from 'react-router-dom';

import { type RailDestination, isRailDestinationActive } from '../railDestinations';

import { RailSubmenuHead, RailSubmenuRow, RailSubmenuShell } from './RailSubmenuShell';
import { useRailSubmenuOpen } from './useRailSubmenuOpen';

/**
 * Any rail destination that carries `children` (currently: Saved Searches,
 * with Asks beside it — both a bounded search run as you, so two rows for
 * one primitive read as two unrelated places — and Jobs, with its category
 * rows). Renders the head as its own link plus a chevron that reveals the
 * children as a compact group.
 *
 * Was `ChatSubmenu` — Chat itself moved under Memory (its recent threads went
 * with it, into `MemorySubmenu`), and this generic shell is what remained:
 * any destination with `children` uses it, not one hardcoded id at a time.
 *
 * Open rules live in {@link useRailSubmenuOpen} — exclusive with Planning,
 * Memory, and Self, so clicking one open closes the others instead of
 * stacking.
 */
export function DestinationWithChildrenSubmenu({ destination }: { destination: RailDestination }) {
  const { pathname } = useLocation();
  const children = destination.children ?? [];
  const routeOpen =
    isRailDestinationActive(destination, pathname) ||
    children.some((child) => isRailDestinationActive(child, pathname));
  const { open, onOpenChange, onHeadClick } = useRailSubmenuOpen(destination.id, routeOpen);
  const Icon = destination.icon;
  const icon = <Icon className="h-6 w-6 shrink-0" strokeWidth={1.25} />;

  return (
    <RailSubmenuShell
      to={destination.to}
      ariaLabel={destination.label}
      chevronLabel={destination.label}
      routeOpen={routeOpen}
      open={open}
      onOpenChange={onOpenChange}
      onHeadClick={onHeadClick}
      testId={`${destination.id}-submenu`}
      collapsedIcon={icon}
      head={<RailSubmenuHead icon={icon} label={destination.label} />}
    >
      {children.map((child) => {
        const ChildIcon = child.icon;
        const active = isRailDestinationActive(child, pathname);

        return (
          <RailSubmenuRow
            key={child.id}
            to={child.to}
            label={child.label}
            active={active}
            icon={<ChildIcon className="h-4 w-4 text-muted-foreground" strokeWidth={1.25} />}
          />
        );
      })}
    </RailSubmenuShell>
  );
}
