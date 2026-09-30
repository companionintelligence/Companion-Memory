import type { LucideIcon } from '@ci/shadcn/icons';
import {
  BookOpen,
  Brain,
  Cable,
  CircleUserRound,
  CloudSun,
  FolderSearch2,
  History,
  LifeBuoy,
  ListTodo,
  MessageCircleQuestion,
  ShieldCheck,
  Workflow,
} from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';
import { isMemoryHubPath } from '@/components/MemoryHub/memoryHubSections';
import { isJobsPath, JOBS_CATEGORY_SECTIONS, JOBS_SECTIONS } from '@/pages/JobsPage/jobsSections';
import { isSourcesPath, SOURCES_SECTIONS } from '@/pages/SourcesPage/sourcesSections';

/**
 * The rail's two clusters, drawn apart by space and a hairline rather than a
 * label: the places you work, then the machinery behind them — where data
 * comes from (Sources), what the appliance runs for itself (Jobs), and what
 * software did or wants to do on your behalf (Approvals).
 */
export type RailCluster = 'work' | 'system';

/**
 * Destinations in the Power Rail, top to bottom (and on the phone, the same
 * list inside the overlay drawer).
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
  /**
   * Rows that belong under this one, as one compact group.
   *
   * The head is still its own destination — the children sit beside it, they
   * do not replace it. A child rides its OWN flag: if the head is gated off,
   * surviving children are promoted back to the top level rather than
   * disappearing with it (see {@link visibleRailDestinations}).
   */
  readonly children?: readonly RailDestination[];
  /**
   * Which cluster a top-level row sits in; `work` when unset. Children render
   * inside their head and never read it — a child promoted to the top level
   * (its head gated off) takes its head's.
   */
  readonly cluster?: RailCluster;
}

export const RAIL_DESTINATIONS: readonly RailDestination[] = [
  // Planning: Tasks (the kanban board) and Calendar (the week grid + brief),
  // one destination with two sub-views — see PlanningSubmenu, rendered for
  // this id the same way MemorySubmenu is rendered for 'memory' below. No
  // `flag` here: Calendar must stay reachable even with `planning.page` off,
  // so only the Tasks sub-view (inside PlanningSubmenu) rides that flag.
  { id: 'plan', to: '/plan', label: 'Planning', icon: ListTodo, end: false },
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
  // Sources carries its own halves the way Jobs and Memory do. The page has
  // always had three — Services, Import, Devices — but the rail offered only
  // the question, so reaching Devices meant landing on Services first and
  // knowing a switch existed above the fold.
  //
  // Derived from SOURCES_SECTIONS rather than restated, so the rail and the
  // page's own tiles cannot drift. Import rides its flag: gated off, the row
  // goes with it rather than pointing at a route that redirects away.
  {
    id: 'sources',
    to: '/sources',
    label: 'Sources',
    icon: Cable,
    end: false,
    match: isSourcesPath,
    cluster: 'system',
    children: SOURCES_SECTIONS.map((section) => ({
      id: section.id,
      to: section.to,
      label: section.label,
      icon: section.icon,
      flag: section.flag,
      match: section.match,
    })),
  },
  // Jobs carries its own sections the way Memory does — everything the page
  // shows used to be one scroll (summary, charts, the table, dead letters and
  // 53 schedules on a single route), which is fine to read once and miserable
  // to return to: the thing you came back for is never at the top and there is
  // no way to link a colleague to it.
  //
  // The category rows underneath are the same ten buckets the table's chip row
  // uses, in the same system order, so the submenu and the page agree about how
  // the appliance is arranged. They are ROUTES rather than `/jobs?category=…`
  // because `isRailDestinationActive` only ever sees the pathname — query-param
  // children would leave all ten rows lit on every visit to /jobs.
  {
    id: 'jobs',
    to: '/jobs',
    label: 'Jobs',
    icon: Workflow,
    flag: 'jobs.page',
    end: false,
    match: isJobsPath,
    cluster: 'system',
    children: [
      ...JOBS_SECTIONS.filter((section) => section.id !== 'overview').map((section) => ({
        id: section.id,
        to: section.to,
        label: section.label,
        icon: section.icon,
        flag: 'jobs.page',
        match: section.match,
      })),
      ...JOBS_CATEGORY_SECTIONS.map((section) => ({
        id: section.id,
        to: section.to,
        label: section.label,
        icon: section.icon,
        flag: 'jobs.page',
        match: section.match,
      })),
    ],
  },
  // Approvals and Activity: what SOFTWARE did on your behalf, as against Jobs
  // above, which is what the appliance does for itself. Approvals is the head
  // because it is the one that is waiting on you — an unanswered card is an
  // agent stopped mid-task — and Activity is the record of the same events
  // after the fact.
  //
  // Both routes shipped complete, tested and unflagged and nothing linked to
  // either, so the only way to reach them was to type the URL. That is the
  // failure this file's own `visibleRailDestinations` comment warns about: a
  // page you can only type at. Neither carries a `flag`, matching the route
  // decision in App.tsx — `tools.pendingActions` gates whether the owner's DIAL
  // queues their own actions, but an installed app is queued unconditionally,
  // so cards arrive with the flag off and a gated row would hide them.
  {
    id: 'approvals',
    to: '/approvals',
    label: 'Approvals',
    icon: ShieldCheck,
    cluster: 'system',
    children: [{ id: 'activity', to: '/activity', label: 'Activity', icon: History }],
  },
  // Below Jobs, off the primary six, while its flag ships false — turning it
  // on later should not disturb the places you actually work. That includes
  // the cluster: it joins the one it already sits at the foot of, rather than
  // opening a third under its own hairline.
  {
    id: 'forecast',
    to: '/forecast',
    label: 'Forecast',
    icon: CloudSun,
    flag: 'forecast.page',
    cluster: 'system',
  },
  // Combines the former About You / Account settings and the Stats page —
  // one destination for "who I am to the system", rendered as the user tile
  // at the foot of the rail rather than in the destination list.
  //
  // ═══ THIS USED TO RIDE `stats.page`, AND THAT REMOVED LOG OUT ═══
  //
  // The tile is the only mount point for `NavUserMenu` (SelfSubmenu renders it;
  // nothing else does), and that menu is the only Theme / Log out cluster in
  // the shell. Settings sits beside Profile in the same submenu. The other two
  // logout call sites both live inside the
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

export function visibleRailDestinations(
  isFeatureEnabled: (flag: string) => boolean,
  destinations: readonly RailDestination[] = RAIL_DESTINATIONS,
): RailDestination[] {
  return destinations.flatMap((destination): RailDestination[] => {
    const children = (destination.children ?? []).filter((child) => isVisible(child, isFeatureEnabled));

    // A group head going dark must not take its children with it — Saved
    // Searches itself is ungated, but this still matters for any future group
    // head that carries a flag: its children ride their own flags (Asks rides
    // `ask`, not a parent's flag) and stay reachable rather than becoming a
    // page you can only type at. They keep their head's cluster, so a promoted
    // child stays where its head stood instead of opening a hairline of its own.
    if (!isVisible(destination, isFeatureEnabled)) {
      return children.map((child) => ({ ...child, cluster: child.cluster ?? destination.cluster }));
    }

    return [{ ...destination, children }];
  });
}

/**
 * Top-level rows split into the rail's clusters: consecutive runs that share
 * one, in rail order. A run, not a bucket, so the rail can never reorder rows
 * to gather a cluster together.
 */
export function railClusters(destinations: readonly RailDestination[]): RailDestination[][] {
  const clusters: RailDestination[][] = [];
  let current: RailCluster | null = null;

  for (const destination of destinations) {
    const cluster = destination.cluster ?? 'work';

    if (cluster !== current) {
      clusters.push([]);
      current = cluster;
    }

    clusters[clusters.length - 1].push(destination);
  }

  return clusters;
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
