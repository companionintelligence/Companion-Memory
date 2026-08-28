import type { LucideIcon } from '@ci/shadcn/icons';
import {
  BookOpen,
  Brain,
  Cable,
  CalendarRange,
  CircleUserRound,
  CloudSun,
  FolderSearch2,
  LifeBuoy,
  ListTodo,
  MessageCircleQuestion,
  Workflow,
} from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';
import { isMemoryHubPath } from '@/components/MemoryHub/memoryHubSections';

/**
 * Destinations in the Power Rail, top to bottom (and on the phone, the same
 * list inside the glass overlay drawer).
 */
export interface RailDestination {
  readonly id: string;
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly flag?: string;
  /** When false, a child path of `to` still counts as this destination. */
  readonly end?: boolean;
  readonly match?: (pathname: string) => boolean;
  readonly badge?: 'feed' | 'plan';
  /**
   * Rows that belong under this one, as one compact group.
   *
   * The head is still its own destination — the children sit beside it, they
   * do not replace it. A child rides its OWN flag: if the head is gated off,
   * surviving children are promoted back to the top level rather than
   * disappearing with it (see {@link visibleRailDestinations}).
   */
  readonly children?: readonly RailDestination[];
}

export const RAIL_DESTINATIONS: readonly RailDestination[] = [
  { id: 'plan', to: '/plan', label: 'Plan', icon: ListTodo, flag: 'planning.page', badge: 'plan' },
  { id: 'calendar', to: '/calendar', label: 'Calendar', icon: CalendarRange, badge: 'feed', end: false },
  // Chat moved under Memory (/memory/chat) — it's a bounded view over your
  // own history the same way Events/People/Places are, not a peer place. See
  // MEMORY_HUB_SECTIONS.
  { id: 'memory', to: '/memory', label: 'Memory', icon: Brain, match: isMemoryHubPath },
  // Asks rides beside Saved Searches, not Chat: both are a bounded search run
  // as you — Share is a link *I* mint, Ask is a request *they* mint. Two rows
  // for one primitive read as two unrelated places.
  //
  // `end: false` so /saved-searches/:id (if it ever exists) still lights up
  // this row the same way Sources' children do.
  {
    id: 'saved-searches',
    to: '/saved-searches',
    label: 'Saved Searches',
    icon: FolderSearch2,
    end: false,
    children: [
      // `ask`, not `asks.page`: this is the SAME flag the /asks route and every
      // ask resolver check, so the rail row and the page it points at can never
      // disagree. A rail entry gated on a different flag is a link to a 404.
      { id: 'asks', to: '/asks', label: 'Asks', icon: MessageCircleQuestion, flag: 'ask' },
    ],
  },
  { id: 'sources', to: '/sources', label: 'Sources', icon: Cable, end: false },
  { id: 'jobs', to: '/jobs', label: 'Jobs', icon: Workflow, flag: 'jobs.page' },
  // Below Jobs, off the primary six, while its flag ships false — turning it
  // on later should not disturb the places you actually work.
  { id: 'forecast', to: '/forecast', label: 'Forecast', icon: CloudSun, flag: 'forecast.page' },
  // Combines the former About You / Account settings and the Stats page —
  // one destination for "who I am to the system", rendered as the user tile
  // at the foot of the rail rather than in the destination list.
  //
  // ═══ THIS USED TO RIDE `stats.page`, AND THAT REMOVED LOG OUT ═══
  //
  // The tile is the only mount point for `NavUserMenu` (SelfSubmenu renders it;
  // nothing else does), and `NavUserMenu` is the only Settings / Theme / Log out
  // cluster in the shell. The other two logout call sites both live inside the
  // `/self/*` subtree, which was gated on the same flag. So turning off a flag
  // named for a STATISTICS PAGE removed the user's avatar, their whole identity
  // surface, the theme switcher, Settings, and every way to sign out — leaving
  // no route back except clearing storage.
  //
  // `self.page` is its own flag now, and `stats.page` gates only the Stats entry
  // inside the tile (see selfSections.ts), which is what its name always claimed.
  { id: 'self', to: '/self', label: 'Self', icon: CircleUserRound, flag: 'self.page', end: false },
];

export const HELP_LINKS = [
  { href: 'https://ci.computer/support', label: 'Support', icon: LifeBuoy },
  {
    href: 'https://docs.ci.computer/docs/apps-available/first-party-apps/companion-memory-server',
    label: 'Docs',
    icon: BookOpen,
  },
] as const;

function isVisible(destination: RailDestination, isFeatureEnabled: (flag: string) => boolean): boolean {
  return !destination.flag || isFeatureEnabled(destination.flag);
}

export function visibleRailDestinations(isFeatureEnabled: (flag: string) => boolean): RailDestination[] {
  return RAIL_DESTINATIONS.flatMap((destination) => {
    const children = (destination.children ?? []).filter((child) => isVisible(child, isFeatureEnabled));

    // A group head going dark must not take its children with it — Saved
    // Searches itself is ungated, but this still matters for any future group
    // head that carries a flag: its children ride their own flags (Asks rides
    // `ask`, not a parent's flag) and stay reachable rather than becoming a
    // page you can only type at.
    if (!isVisible(destination, isFeatureEnabled)) {
      return children;
    }

    return [{ ...destination, children }];
  });
}

/** Every destination, group heads and their children alike, flat. */
export function allRailDestinations(): RailDestination[] {
  return RAIL_DESTINATIONS.flatMap((destination) => [destination, ...(destination.children ?? [])]);
}

export function useVisibleRailDestinations(): RailDestination[] {
  const { isFeatureEnabled } = useFeatures();

  return visibleRailDestinations(isFeatureEnabled);
}

export function isRailDestinationActive(destination: RailDestination, pathname: string): boolean {
  if (destination.match) {
    return destination.match(pathname);
  }

  if (destination.end === false) {
    return pathname === destination.to || pathname.startsWith(`${destination.to}/`);
  }

  return pathname === destination.to;
}
