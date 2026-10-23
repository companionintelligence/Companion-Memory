import { useSearchParams } from 'react-router-dom';

import { useAnswersFromDevice } from '@/api/powersync/deviceFallback';
import { MemoryEmptyState } from '@/pages/MemoryPage/Components';
import {
  countActiveFilters,
  resolveExplorerTypes,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

import { EntityResultList } from '../ListView';
import { LocalListView } from '../LocalListView';
import { useEntityService } from '../useEntityService';

/**
 * The everything browse behind a bare `/memory`: one flat list of whatever the
 * filters match — messages and events beside people, content, things and
 * answers — in the order the server ranked them, which is relevance.
 *
 * This is deliberately not ListView. That list is a chronology: it groups rows
 * under date headings and parks whatever has no date under a trailing "No
 * date" heading. For the events browse that is right. For a grab bag of kinds
 * it was not: most of what came back had no date, so the reader saw a few
 * dated rows, then a "No date" pile — and when the next page arrived, its
 * dated rows filed themselves into the headings *above* the pile the reader
 * had scrolled to, so scrolling back up showed rows they had never seen.
 *
 * Flat, ranked rows only ever append at the bottom. Date headings come back
 * only when the reader has asked for time order — Newest / Oldest, which the
 * Sort control offers here only inside a When filter (see sortOptions) — and
 * by then the When override has kept the undated kinds out of the request
 * (see resolveExplorerTypes), so the headings are meaningful again.
 *
 * When the Memory server does not answer and this phone has a synced replica,
 * the same URL renders LocalListView instead — the list the device can give,
 * labelled as such (see deviceFallback.ts).
 */
export function ExploreView() {
  const [searchParams] = useSearchParams();
  const [{ error }] = useEntityService();
  const offline = useAnswersFromDevice(error);
  const hasQuery = Boolean(searchParams.get('search')?.trim());
  const grouped = searchParams.get('sortBy') === 'time';
  const filteredBrowse = countActiveFilters(searchParams) > 0 || hasQuery;
  const { droppedByWhen } = resolveExplorerTypes(searchParams);

  if (offline) {
    return <LocalListView />;
  }

  return (
    <EntityResultList
      grouped={grouped}
      emptyState={<MemoryEmptyState filtered={filteredBrowse} whenDroppedTypes={droppedByWhen} />}
    />
  );
}
