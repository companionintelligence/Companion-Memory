import { useSearchParams } from 'react-router-dom';

import { MemoryEmptyState, isChronologicalSort } from '@/pages/MemoryPage/Components';
import { countActiveFilters } from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

import { EntityResultList } from './EntityResultList';

/**
 * The happenings list (`/memory/events`, and the shared-search viewer): rows in
 * time order under date headings whenever the sort keeps them in time order.
 * The everything browse on `/memory` is ExploreView, which makes no such
 * promise — see that file for why the two are different views.
 */
export function ListView() {
  const [searchParams] = useSearchParams();
  const hasQuery = Boolean(searchParams.get('search')?.trim());
  // Date-group headers only make sense while results are in chronological order.
  // Relevance/name sorts interleave dates, so we fall back to a flat list there
  // (grouping then would emit repeated, out-of-order headers).
  const grouped = isChronologicalSort(searchParams.get('sortBy'), hasQuery);
  const filteredBrowse = countActiveFilters(searchParams) > 0 || hasQuery;

  return <EntityResultList grouped={grouped} emptyState={<MemoryEmptyState filtered={filteredBrowse} />} />;
}
