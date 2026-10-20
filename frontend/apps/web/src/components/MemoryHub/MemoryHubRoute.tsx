import type { ReactNode } from 'react';

import { useLocation } from 'react-router-dom';

import { ProtectedRoute } from '@/components/ProtectedRoute';

import { MemoryHubSectionSkeleton } from './MemoryHubSkeletons';

/**
 * ProtectedRoute for a Memory hub section: the section's skeleton, not a
 * spinner, while its code downloads.
 *
 * The router runs without transitions (see App.tsx), so the first visit to a
 * lazily loaded section always shows the nearest Suspense fallback, and
 * ProtectedRoute's own boundary is nearer than MemoryHubLayout's. With the
 * default fallback every first tap on a tab put a spinner under the strip
 * before the section's own skeleton replaced it.
 */
export function MemoryHubRoute({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  return (
    <ProtectedRoute fallback={<MemoryHubSectionSkeleton pathname={pathname} />}>{children}</ProtectedRoute>
  );
}
