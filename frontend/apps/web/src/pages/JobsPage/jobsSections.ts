import type { LucideIcon } from '@ci/shadcn/icons';
import { Activity, CircleSlash, LayoutDashboard, LineChart, Timer } from '@ci/shadcn/icons';

import {
  CATEGORIES_IN_SYSTEM_ORDER,
  categoryIcon,
  categoryLabel,
  UNCLASSIFIED_CATEGORY,
} from './jobCategories';

/**
 * The Jobs page's own destinations — shared by the Power Rail submenu and the
 * page's section switch, so labels, routes and matchers stay in lockstep.
 *
 * Modelled on `components/MemoryHub/memoryHubSections.ts`, which solves the same
 * problem for Memory: one exported list, two consumers, no second copy of the
 * routes to drift.
 *
 * Everything the Jobs page shows used to be one scroll — summary, charts, the
 * table, dead letters and 53 schedules stacked on a single route. That is fine
 * to read top-to-bottom once and miserable to return to, because the thing you
 * came back for is never at the top and there is no way to link a colleague to
 * it. These are the four surfaces worth their own address.
 */
export interface JobsSection {
  readonly id: string;
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** True when `pathname` should light this section up. */
  readonly match: (pathname: string) => boolean;
}

/** Route prefix for a category deep-link, e.g. `/jobs/category/ingest`. */
export const JOBS_CATEGORY_BASE = '/jobs/category';

export const JOBS_SECTIONS: readonly JobsSection[] = [
  {
    id: 'overview',
    to: '/jobs',
    label: 'Overview',
    icon: LayoutDashboard,
    // Only the bare route — every other section is a child path of it, and a
    // matcher of `startsWith('/jobs')` would light Overview up on all of them.
    match: (p) => p === '/jobs',
  },
  {
    id: 'jobs-history',
    to: '/jobs/history',
    label: 'History',
    icon: LineChart,
    match: (p) => p === '/jobs/history',
  },
  {
    id: 'jobs-schedules',
    to: '/jobs/schedules',
    label: 'Schedules',
    icon: Timer,
    match: (p) => p === '/jobs/schedules',
  },
  {
    id: 'jobs-dead-letters',
    to: '/jobs/dead-letters',
    label: 'Dead letters',
    icon: CircleSlash,
    match: (p) => p === '/jobs/dead-letters',
  },
];

/**
 * One destination per job category, deep-linking into the filtered table.
 *
 * A ROUTE, not `/jobs?category=…`. The rail decides which row is lit from the
 * pathname alone (`isRailDestinationActive` never sees the query string), so
 * query-param children would leave all ten rows lit on every visit to `/jobs`.
 *
 * Ordered by system — Intake, Processing, Recall, Companion, Upkeep — matching
 * the chip row on the table, so the submenu and the page tell the same story
 * about how the appliance is arranged. `unclassified` is deliberately absent:
 * it is the absence of a classification rather than a place, and a permanent
 * rail row for it would give a bug a home.
 */
export const JOBS_CATEGORY_SECTIONS: readonly JobsSection[] = CATEGORIES_IN_SYSTEM_ORDER.filter(
  (category) => category !== UNCLASSIFIED_CATEGORY,
).map((category) => ({
  id: `jobs-category-${category}`,
  to: `${JOBS_CATEGORY_BASE}/${category}`,
  label: categoryLabel(category),
  icon: categoryIcon(category),
  match: (p: string) => p === `${JOBS_CATEGORY_BASE}/${category}`,
}));

/** Every Jobs route, for the rail's active-state check on the `jobs` head. */
export function isJobsPath(pathname: string): boolean {
  return pathname === '/jobs' || pathname.startsWith('/jobs/');
}

/**
 * The category a pathname selects, or `null` for the section routes.
 *
 * Returns the raw segment rather than validating it against the taxonomy: an
 * unknown category is the server's business (it answers with an empty table
 * rather than an unfiltered one), and hard-coding the valid set here would be a
 * second copy of the taxonomy to keep in step.
 */
export function categoryFromPath(pathname: string): string | null {
  if (!pathname.startsWith(`${JOBS_CATEGORY_BASE}/`)) {
    return null;
  }

  const segment = pathname.slice(`${JOBS_CATEGORY_BASE}/`.length).split('/')[0];

  return segment ? decodeURIComponent(segment) : null;
}

/** Icon for the Jobs rail head — exported so the rail need not import Activity itself. */
export const JOBS_ICON = Activity;
