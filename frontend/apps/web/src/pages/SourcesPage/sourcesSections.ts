import type { LucideIcon } from '@ci/shadcn/icons';
import { Cable, MonitorSmartphone, PackageOpen } from '@ci/shadcn/icons';

/**
 * The Sources page's own destinations — shared by the Power Rail submenu and
 * the page's path tiles, so labels, routes, icons and flags stay in lockstep.
 *
 * Modelled on `pages/JobsPage/jobsSections.ts` and
 * `components/MemoryHub/memoryHubSections.ts`, which solve the same problem for
 * Jobs and Memory: one exported list, two consumers, no second copy of the
 * routes to drift apart.
 *
 * Sources is three genuinely different answers to one question — sign into a
 * service, hand over an archive, install something on a machine — and until
 * now the rail offered only the question. Reaching Devices meant landing on
 * Services first and knowing a switch existed above the fold.
 */
/** The three halves, as the `/sources/:half` route names them. */
export type SourcePath = 'connect' | 'import' | 'devices';

export interface SourcesSection {
  readonly id: string;
  /** The `:half` route param, and the key the page's tiles are stored under. */
  readonly path: SourcePath;
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Feature flag this section rides, when it has one. */
  readonly flag?: string;
  /** True when `pathname` should light this section up. */
  readonly match: (pathname: string) => boolean;
}

export const SOURCES_SECTIONS: readonly SourcesSection[] = [
  {
    id: 'sources-connect',
    path: 'connect',
    to: '/sources/connect',
    label: 'Services',
    icon: Cable,
    // `/sources` itself normalises to this half (SourcesPage redirects), so it
    // lights up for the bare route too — otherwise landing on /sources shows a
    // rail with nothing selected while Services is plainly on screen.
    match: (p) => p === '/sources' || p.startsWith('/sources/connect'),
  },
  {
    id: 'sources-import',
    path: 'import',
    to: '/sources/import',
    label: 'Import',
    icon: PackageOpen,
    // The only gated half. A gated ROUTE in this app is never registered
    // rather than blocked, so with the flag off /sources/import redirects to
    // Services — the row must disappear with it, not lead somewhere else.
    flag: 'import.page',
    match: (p) => p.startsWith('/sources/import'),
  },
  {
    id: 'sources-devices',
    path: 'devices',
    to: '/sources/devices',
    label: 'Devices',
    icon: MonitorSmartphone,
    match: (p) => p.startsWith('/sources/devices'),
  },
];

/** True for any path the Sources destination owns. */
export function isSourcesPath(pathname: string): boolean {
  return pathname === '/sources' || pathname.startsWith('/sources/');
}
