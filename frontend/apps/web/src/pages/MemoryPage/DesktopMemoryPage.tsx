import { useState, useEffect, useRef } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, Portal } from '@ci/common';
import { ENTITY_TYPE_REVERSE_MAP } from '@ci/common/src/constants';
import { Breadcrumb, Tabs, Sheet } from '@ci/shadcn';
import { ChartNetwork, Images, List, Map as MapIcon, type LucideIcon } from '@ci/shadcn/icons';
import { useSearchParams, Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { AVAILABLE_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';

import { useEntityService } from '../MemoryPage/useEntityService';

import { EntityDetails } from './Components/EntityDetails';
import { countActiveFilters } from './Components/ExplorerToolbar/ActiveFilterChips';
import { AdvancedSearchToggle, ExplorerToolbar } from './Components/ExplorerToolbar/ExplorerToolbar';
import { GalleryView } from './GalleryView';
import { GraphView } from './GraphView';
import { ListView } from './ListView';
import { DesktopMapView } from './MapView';

const GET_SAVED_SEARCH = gql(`
  query GetSavedSearch($id: ID!) {
    savedSearch(id: $id) {
      id
      name
      description
      query
      entityTypes
      tags
    }
  }
`);

const VIEW_TABS: Array<{
  value: string;
  label: string;
  title: string;
  Icon: LucideIcon;
}> = [
  { value: 'map', label: 'Map', title: 'Map view', Icon: MapIcon },
  { value: 'list', label: 'List', title: 'List view', Icon: List },
  { value: 'gallery', label: 'Gallery', title: 'Gallery view', Icon: Images },
  { value: 'graph', label: 'Graph', title: 'Graph view', Icon: ChartNetwork },
];

export default function DesktopMemoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [{ activeEntity }, { setActiveEntity }] = useEntityService();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchId, setSearchId] = useState<string | null>(null);

  // The active view lives in the URL (`?view=`) so a query is shareable and
  // restores in the same view; list is the desktop default since it always
  // shows results (the map renders empty for data without coordinates).
  const activeTab = searchParams.get('view') ?? 'list';
  const setActiveTab = (next: string) =>
    setSearchParams((params) => {
      const nextParams = new URLSearchParams(params);
      nextParams.set('view', next);

      return nextParams;
    });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Make the default view explicit in the URL so the query is shareable and so
  // MemoryPage can derive the map's hasLocation scope from `?view=`.
  useEffect(() => {
    if (!searchParams.get('view')) {
      setSearchParams(
        (params) => {
          const nextParams = new URLSearchParams(params);
          nextParams.set('view', 'list');

          return nextParams;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams]);

  const { data: savedSearchData } = useQuery(GET_SAVED_SEARCH, {
    variables: { id: GlobalUID.encode('saved-search', searchId!) },
    skip: !searchId,
  });

  useEffect(() => {
    if (savedSearchData?.savedSearch) {
      const currentParams = new URLSearchParams(searchParams);
      const { entityTypes, query, tags } = savedSearchData.savedSearch;

      currentParams.delete('search');
      currentParams.delete('excludedEntityTypes');
      currentParams.delete('includedEntityTypes');
      currentParams.delete('saved_search');
      currentParams.delete('tags');

      if (query?.trim()) {
        currentParams.set('search', query.trim());
      }

      if (entityTypes?.length && entityTypes.length > 0) {
        const reverseMapped = entityTypes.map(
          (type) => ENTITY_TYPE_REVERSE_MAP[type as keyof typeof ENTITY_TYPE_REVERSE_MAP],
        );
        const inverseEntityTypes = AVAILABLE_ENTITY_TYPES.filter(
          (entity) => reverseMapped.indexOf(entity) === -1,
        );
        const mappedEntityTypes = inverseEntityTypes.join(',');
        currentParams.set('excludedEntityTypes', mappedEntityTypes);
      }

      //Updating included entities is handled in SearchBox.tsx

      if (tags?.length && tags.length > 0) {
        currentParams.set('tags', tags.join(','));
      }

      setSearchParams(currentParams);
    }
  }, [searchId, savedSearchData]);

  // Matches the Sheet's `data-[state=closed]:duration-300` close animation.
  const CLOSE_ANIMATION_MS = 300;
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (activeEntity != null) {
      // A (possibly new) entity is active — cancel any pending unmount and open.
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }

      setDetailsOpen(true);
    }
  }, [activeEntity]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const toggleactiveEntity = (active: boolean) => {
    setDetailsOpen(active);

    if (!active) {
      // Keep the Sheet mounted while it animates out, then drop the entity.
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
      }

      closeTimerRef.current = window.setTimeout(() => {
        setActiveEntity(null);
        closeTimerRef.current = null;
      }, CLOSE_ANIMATION_MS);
    }
  };

  useEffect(() => {
    const savedSearchId = searchParams.get('saved_search') || '';
    if (savedSearchId?.length > 0) {
      setSearchId(savedSearchId);
    }
  }, []);

  const activeFilterCount = countActiveFilters(searchParams);
  const showExplorerToolbar = advancedOpen || activeTab !== 'map' || activeFilterCount > 0;

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Memory</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      {/* View toggles sit in the unified header bar, right of the stretched search.
          Native `title` for the hover label rather than a Radix Tooltip: wrapping
          Tabs.Trigger in Tooltip.Trigger renders a button inside a button (invalid
          HTML + hydration error), and merging them (asChild) makes the tooltip's
          data-state clobber the tab's active/inactive state. */}
      <Portal.Slot id="nav-views">
        <Tabs defaultValue="map" onValueChange={setActiveTab} value={activeTab}>
          <Tabs.List className="flex h-9 items-center border">
            {VIEW_TABS.map(({ value, label, title, Icon }) => {
              const active = activeTab === value;

              return (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  title={title}
                  aria-label={title}
                  className="flex h-7 w-8 flex-none items-center justify-center px-0 data-[state=active]:w-auto data-[state=active]:px-2.5"
                >
                  <Icon className="h-4 w-4" />
                  {active && <span>{label}</span>}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        </Tabs>
      </Portal.Slot>

      {/* The Advanced toggle sits in the header, right of the search; it controls
          the toolbar drawer below via the lifted `advancedOpen` state. */}
      <Portal.Slot id="nav-tools">
        <AdvancedSearchToggle
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((open) => !open)}
          className="rounded-l-none border-l-0"
        />
      </Portal.Slot>

      <PageContent className="p-0 gap-0">
        {/* Advanced-search drawer (when open) + active-filter chips + result count. */}
        {showExplorerToolbar && (
          <div className={advancedOpen ? 'px-4 pt-0' : 'px-4 pt-3'}>
            <ExplorerToolbar open={advancedOpen} showResultCount={activeTab !== 'map'} attachedToHeader />
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {activeTab === 'list' && <ListView />}
          {activeTab === 'map' && <DesktopMapView />}
          {activeTab === 'gallery' && <GalleryView />}
          {activeTab === 'graph' && <GraphView variant="desktop" />}
        </div>
      </PageContent>

      {activeEntity && (
        <Sheet open={detailsOpen} onOpenChange={toggleactiveEntity}>
          <EntityDetails entity={activeEntity} />
        </Sheet>
      )}
    </>
  );
}
