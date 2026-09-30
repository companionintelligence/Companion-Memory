import { type ReactNode } from 'react';

import { Collapsible, Tooltip, cn } from '@ci/shadcn';
import { ChevronRight, CircleHelp } from '@ci/shadcn/icons';

import { CaptureModal } from '@/components/modals/CaptureModal';
import { useCaptureModal } from '@/hooks';

import { usePowerRail } from '../PowerRailContext';
import { PowerRailWordmark } from '../PowerRailToggle';
import {
  HELP_LINKS,
  type RailDestination,
  railClusters,
  useVisibleRailDestinations,
} from '../railDestinations';
import { RailEdgeToggle } from '../RailEdgeToggle';

import { CaptureRailButton } from './CaptureRailButton';
import { DestinationWithChildrenSubmenu } from './DestinationWithChildrenSubmenu';
import { MemorySubmenu } from './MemorySubmenu';
import { NavLink } from './NavLink';
import { PlanningSubmenu } from './PlanningSubmenu';
import {
  RAIL_CHILD_HEIGHT,
  RAIL_CHILD_INSET,
  RAIL_SECTION_HEIGHT,
  RAIL_SECTION_INSET,
  RailChildren,
  railRowTone,
} from './railRow';
import { SelfSubmenu } from './SelfSubmenu';

interface ExternalNavLinkProps {
  href: string;
  label: string;
  children: ReactNode;
}

/**
 * One of Help's rows — a child row, like Tasks under Planning. Only the open
 * rail shows them: collapsed, Help is a single icon (see {@link HelpSubmenu}).
 */
function ExternalNavLink({ href, label, children }: ExternalNavLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={cn(
        'relative flex min-w-0 items-center gap-2.5 rounded-md text-sm transition will-change-transform active:scale-95',
        RAIL_CHILD_HEIGHT,
        RAIL_CHILD_INSET,
        railRowTone(false),
      )}
    >
      {children}
      <span className="truncate">{label}</span>
    </a>
  );
}

/**
 * Support and Docs, under one entry.
 *
 * Two separate rows for "where do I get help" is one more than the question
 * has. Collapsed, it is a single icon whose tooltip says Help; the two
 * destinations are one click in either state, rather than two permanent rows
 * competing with the places you actually work.
 */
function HelpSubmenu() {
  const { expanded } = usePowerRail();

  if (!expanded) {
    return (
      <Tooltip>
        <Tooltip.Trigger asChild>
          <a
            href={HELP_LINKS[0].href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Help"
            className={cn(
              'relative flex items-center justify-center rounded-md transition active:scale-95',
              RAIL_SECTION_HEIGHT,
              railRowTone(false),
            )}
          >
            <CircleHelp className="h-6 w-6 shrink-0" strokeWidth={1.25} />
          </a>
        </Tooltip.Trigger>
        <Tooltip.Content side="right">Help</Tooltip.Content>
      </Tooltip>
    );
  }

  return (
    <Collapsible>
      {/* A section row like the ones above it: its icon on their icon column,
          "Help" on their label column — which is also where the account row
          below starts its name. */}
      <Collapsible.Trigger
        className={cn(
          'flex w-full items-center gap-3 rounded-md text-left transition [&[data-state=open]>svg:last-child]:rotate-90',
          RAIL_SECTION_HEIGHT,
          RAIL_SECTION_INSET,
          railRowTone(false),
        )}
      >
        <CircleHelp className="h-6 w-6 shrink-0" strokeWidth={1.25} />
        <span className="flex-1 truncate text-sm">Help</span>
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200" />
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <RailChildren>
          {HELP_LINKS.map((link) => {
            const Icon = link.icon;

            return (
              <ExternalNavLink key={link.href} href={link.href} label={link.label}>
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.25} />
              </ExternalNavLink>
            );
          })}
        </RailChildren>
      </Collapsible.Content>
    </Collapsible>
  );
}

/**
 * The drawer says which app you are in.
 *
 * Desktop earns the wordmark by pinning, because a name appearing on hover
 * widens the rail's grid column and shoves the page. The phone has neither a
 * hover state nor that column: opening the drawer is deliberate and it floats
 * over the content, so the mark costs nothing and answers the question the
 * bare chevron left open.
 */
function OverlayRailHeader({ closeOverlay }: { closeOverlay: () => void }) {
  return (
    // `border-l-2` + `px-2` matches the rows' inset to their icon
    // (`RAIL_SECTION_INSET`), so the mark centres on the icon column below
    // instead of hugging the pane edge. The border is transparent and never
    // coloured: it is only spacing here.
    <div className="flex min-w-0 items-center border-l-2 border-transparent px-2 py-2">
      <PowerRailWordmark />
      <RailEdgeToggle open onClick={closeOverlay} className="ml-auto shrink-0" />
    </div>
  );
}

/**
 * The part of the rail that scrolls: every destination above the footer.
 *
 * Its bottom edge fades out, so a list that runs on under the footer's divider
 * says so; the padding under the last row lets that row scroll clear of the
 * fade. A mask rather than a gradient painted over the list, because the
 * desktop rail's surface is translucent and no single colour would match it.
 */
function RailScrollArea({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="rail-scroll"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-7 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.75rem),transparent)] [scrollbar-gutter:stable]"
    >
      {children}
    </div>
  );
}

/**
 * Help and the account, pinned under a divider at the foot of the rail while
 * everything above them scrolls — the two are what you reach for from any
 * page, so they never scroll out of reach.
 */
function RailFooter({ showSelf }: { showSelf: boolean }) {
  return (
    <div
      data-testid="rail-footer"
      className="mt-1 flex shrink-0 flex-col gap-0.5 border-t border-border pb-2 pt-2"
    >
      <HelpSubmenu />
      {showSelf ? <SelfSubmenu /> : null}
    </div>
  );
}

function OverlayRail({
  destinationsList,
  closeOverlay,
  expanded,
  showSelf,
}: {
  destinationsList: ReactNode;
  closeOverlay: () => void;
  expanded: boolean;
  showSelf: boolean;
}) {
  return (
    <nav
      id="power-rail"
      aria-label="Main navigation drawer"
      data-state={expanded ? 'expanded' : 'collapsed'}
      aria-hidden={!expanded}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a')) {
          closeOverlay();
        }
      }}
      className={cn(
        // 300px, less a 56px strip of page on the narrowest phones, so there
        // is always some scrim left to tap.
        'fixed inset-y-0 left-0 z-40 flex w-[min(300px,calc(100vw-56px))] flex-col overflow-x-hidden px-2 pb-[max(0.5rem,var(--safe-area-bottom))] pt-[var(--safe-area-top)] transition-transform duration-200',
        // Opaque. A translucent pane let whatever sat behind it — a bright
        // card, the chat page's empty-state icon — bleed through between the
        // rows.
        'border-r border-border bg-background shadow-xl',
        expanded ? 'translate-x-0' : 'pointer-events-none -translate-x-full',
      )}
    >
      <Tooltip.Provider>
        <OverlayRailHeader closeOverlay={closeOverlay} />
        <RailScrollArea>{destinationsList}</RailScrollArea>
        <RailFooter showSelf={showSelf} />
      </Tooltip.Provider>
    </nav>
  );
}

function RailDestinationRow({ destination }: { destination: RailDestination }) {
  if (destination.id === 'memory') {
    return <MemorySubmenu />;
  }

  if (destination.id === 'plan') {
    return <PlanningSubmenu />;
  }

  // Any destination carrying children (currently Saved Searches, with Asks
  // beside it) gets the group treatment: a chevron reveals them. A gated group
  // whose flag is off never reaches here — its children are promoted to plain
  // top-level rows by `visibleRailDestinations` and fall through to the
  // NavLink below.
  if (destination.children && destination.children.length > 0) {
    return <DestinationWithChildrenSubmenu destination={destination} />;
  }

  const Icon = destination.icon;

  return (
    <NavLink to={destination.to} label={destination.label} end={destination.end}>
      <Icon className="h-6 w-6 shrink-0" strokeWidth={1.25} />
    </NavLink>
  );
}

export function SecondaryNavigation() {
  const { expanded, pinned, variant, closeOverlay } = usePowerRail();
  const destinations = useVisibleRailDestinations();
  const [{ isOpen: captureOpen }, { close: closeCapture }] = useCaptureModal();
  const overlay = variant === 'overlay';
  const showSelf = destinations.some((destination) => destination.id === 'self');

  // Self is the account row in the footer, not a destination in the list.
  const clusters = railClusters(destinations.filter((destination) => destination.id !== 'self'));

  const destinationsList = (
    <div className="flex flex-col">
      {clusters.map((cluster, index) => (
        // Space and a hairline between clusters, and no label: the rows say
        // what they are, and a heading would be one more row to scroll past.
        <div
          key={cluster[0].id}
          data-testid="rail-cluster"
          className={cn('flex flex-col gap-0.5', index > 0 && 'mt-2.5 border-t border-border pt-2.5')}
        >
          {index === 0 ? <CaptureRailButton /> : null}
          {cluster.map((destination) => (
            <RailDestinationRow key={destination.id} destination={destination} />
          ))}
        </div>
      ))}
    </div>
  );

  const captureModal = captureOpen ? <CaptureModal open onClose={closeCapture} /> : null;

  if (overlay) {
    return (
      <>
        {captureModal}
        <OverlayRail
          destinationsList={destinationsList}
          closeOverlay={closeOverlay}
          expanded={expanded}
          showSelf={showSelf}
        />
      </>
    );
  }

  return (
    // A drawer, not a column that shoves the page around.
    //
    // The wrapper always occupies the collapsed width, so the layout beside it
    // never moves. The rail itself is absolutely positioned inside that lane
    // and only grows over the content when a click pins it open — nothing
    // here reacts to the pointer, so passing through never costs you a
    // widening panel you didn't ask for.
    //
    // Pinning takes real width instead: the content settles beside it once,
    // and it stays that way.
    <>
      {captureModal}
      <div
        className={cn('relative h-full shrink-0 transition-[width] duration-200', pinned ? 'w-56' : 'w-14')}
      >
        <nav
          id="power-rail"
          aria-label="Main navigation"
          data-state={expanded ? 'expanded' : 'collapsed'}
          className={cn(
            'absolute inset-y-0 left-0 z-30 flex flex-col overflow-x-hidden p-2 transition-[width] duration-200',
            'bg-secondary/20 backdrop-blur-sm',
            expanded ? 'w-56' : 'w-14',
            // Only when it is floating over the content does it need to look
            // like it: pinned, it is part of the furniture.
            expanded && !pinned && 'border-r border-r-secondary/90 shadow-xl',
          )}
        >
          <Tooltip.Provider>
            <RailScrollArea>{destinationsList}</RailScrollArea>
            <RailFooter showSelf={showSelf} />
          </Tooltip.Provider>
        </nav>
      </div>
    </>
  );
}
