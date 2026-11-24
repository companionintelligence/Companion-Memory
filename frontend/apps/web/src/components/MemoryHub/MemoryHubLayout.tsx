import { Suspense } from 'react';

import { Outlet, useLocation } from 'react-router-dom';

import { AppErrorBoundary } from '@/components/AppErrorBoundary';

import { MemoryHubNav } from './MemoryHubNav';
import { MemoryHubSectionSkeleton } from './MemoryHubSkeletons';

/**
 * The Memory hub's frame: the section strip (Events, People, Places, …) and,
 * under it, whichever section is open.
 *
 * A layout route, so the strip is mounted once for the whole hub and moving
 * between sections only swaps what sits under it. Every section page used to
 * render the strip itself, so each switch tore it down and built it again,
 * and a section still loading its first page showed a full-screen spinner
 * with no strip at all.
 *
 * The boundaries sit under the strip, around the section alone, so a section
 * that is still loading or has crashed leaves the strip on screen and usable.
 * Each section's route also wraps it in MemoryHubRoute, whose boundary is the
 * nearer one while its code downloads and shows the same skeleton.
 */
export function MemoryHubLayout() {
  const { pathname } = useLocation();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MemoryHubNav />
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<MemoryHubSectionSkeleton pathname={pathname} />}>
          <AppErrorBoundary>
            <Outlet />
          </AppErrorBoundary>
        </Suspense>
      </div>
    </div>
  );
}
