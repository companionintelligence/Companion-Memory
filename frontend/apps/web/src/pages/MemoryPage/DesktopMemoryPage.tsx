import { useState, useEffect, useRef } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, Portal } from '@ci/common';
import { ENTITY_TYPE_REVERSE_MAP } from '@ci/common/src/constants';
import { Breadcrumb, cn, DropdownMenu, Sheet } from '@ci/shadcn';
import { ChartNetwork, ChevronDown, Images, List, Map as MapIcon, type LucideIcon } from '@ci/shadcn/icons';
import { useSearchParams, Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { AVAILABLE_ENTITY_TYPES, DropdownProvider } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';

import { useEntityService } from '../MemoryPage/useEntityService';

import { EntityDetails } from './Components/EntityDetails';
import { ActiveFilterChips, countActiveFilters } from './Components/ExplorerToolbar/ActiveFilterChips';
import {
  AdvancedFilters,
  AdvancedSearchToggle,
  ResultCount,
} from './Components/ExplorerToolbar/ExplorerToolbar';
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
      filters {
        eventTypes
        startTime
        endTime
        sortBy
        sortOrder
        connectors
        people
        places
        hasLocation
        semantic
      }
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
  // The advanced-filter drawer state lives in the URL (`?advanced=1`) because it
  // renders inside the header SearchBox's dropdown panel (GlobalSearchBox pins
  // the panel open from the same param); this page owns the toggle + content.
  const advancedOpen = searchParams.get('advanced') === '1';
  const toggleAdvanced = () =>
    setSearchParams(
      (params) => {
        const nextParams = new URLSearchParams(params);

        if (advancedOpen) {
          nextParams.delete('advanced');
        } else {
          nextParams.set('advanced', '1');
        }

        return nextParams;
      },
      { replace: true },
    );

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
      const { entityTypes, query, tags, filters } = savedSearchData.savedSearch;

      // Clear every param a saved search owns so a stale filter from the prior
      // view can't survive the restore.
      for (const key of [
        'search',
        'excludedEntityTypes',
        'includedEntityTypes',
        'saved_search',
        'tags',
        'eventTypes',
        'from',
        'to',
        'sortBy',
        'sortOrder',
        'connectors',
        'people',
        'places',
        'hasLocation',
        'semantic',
      ]) {
        currentParams.delete(key);
      }

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

      // Secondary dimensions (who / where / when / how / sort / semantic). The
      // `filters` keys mirror the explorer URL params 1:1 except for the date
      // range (startTime -> ?from, endTime -> ?to).
      if (filters) {
        const setCsv = (param: string, value?: readonly string[] | null) => {
          if (value && value.length > 0) {
            currentParams.set(param, value.join(','));
          }
        };

        setCsv('eventTypes', filters.eventTypes);
        setCsv('connectors', filters.connectors);
        setCsv('people', filters.people);
        setCsv('places', filters.places);

        if (filters.startTime) {
          currentParams.set('from', filters.startTime);
        }

        if (filters.endTime) {
          currentParams.set('to', filters.endTime);
        }

        if (filters.sortBy) {
          currentParams.set('sortBy', filters.sortBy);
        }

        if (filters.sortOrder) {
          currentParams.set('sortOrder', filters.sortOrder);
        }

        if (filters.hasLocation) {
          currentParams.set('hasLocation', '1');
        }

        if (filters.semantic) {
          currentParams.set('semantic', '1');
        }
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
  const activeView = VIEW_TABS.find((tab) => tab.value === activeTab) ?? VIEW_TABS[1];

  return (
    <>
      {/* The view switcher is the last breadcrumb crumb: the current view's name
          is the trigger, and the expansion mirrors the header plus-button's Add
          panel (icon grid) so both header menus read as one pattern. */}
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
            <Breadcrumb.Separator />
            <Breadcrumb.Item>
              <DropdownMenu modal={false}>
                <DropdownMenu.Trigger
                  aria-label={`${activeView.title} — change view`}
                  className="hover:text-foreground flex cursor-pointer items-center gap-1 text-sm transition-colors"
                >
                  {activeView.label}
                  <ChevronDown className="size-3.5" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content className="rounded-lg p-2" side="bottom" align="start" sideOffset={4}>
                  <div className="grid grid-cols-4 gap-2">
                    {VIEW_TABS.map(({ value, label, title, Icon }) => (
                      <DropdownMenu.Item
                        key={value}
                        title={title}
                        onSelect={() => setActiveTab(value)}
                        className={cn(
                          'h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1',
                          activeTab === value && 'bg-accent text-accent-foreground',
                        )}
                      >
                        <Icon className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs">{label}</span>
                      </DropdownMenu.Item>
                    ))}
                  </div>
                </DropdownMenu.Content>
              </DropdownMenu>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      {/* The Advanced toggle sits inset at the right edge of the header search box
          (SearchBox's toolsSlot). Borderless h-8 to match the inset controls. */}
      <Portal.Slot id="nav-tools">
        <AdvancedSearchToggle
          open={advancedOpen}
          onToggle={toggleAdvanced}
          className="h-7 w-7 rounded-md border-0 shadow-none"
        />
      </Portal.Slot>

      {/* The advanced filters and active-filter chips render as a pinned section
          at the top of the header SearchBox's dropdown panel (its panelHeader
          slot), above any live search suggestions — so typing never covers them.
          Chips also surface (without the full controls) whenever the panel opens
          with filters active; when it's closed, the toggle's count badge stands in. */}
      <Portal.Slot id="nav-search-panel">
        {(advancedOpen || activeFilterCount > 0) && (
          <DropdownProvider args={[{ changeSearchParams: true }]}>
            <div className="flex flex-col gap-2 p-3">
              {advancedOpen && (
                <div className="flex flex-wrap items-center gap-2">
                  <AdvancedFilters modal={false} />
                </div>
              )}
              {activeFilterCount > 0 && <ActiveFilterChips />}
            </div>
          </DropdownProvider>
        )}
      </Portal.Slot>

      <PageContent className="p-0 gap-0">
        {/* Result count only — filters and their chips live in the header search
            panel. The map stays full-bleed. */}
        {activeTab !== 'map' && (
          <div className="flex justify-end px-4 pt-3">
            <ResultCount />
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
