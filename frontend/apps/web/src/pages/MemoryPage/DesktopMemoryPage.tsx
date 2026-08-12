import { useState, useEffect, useRef } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, Portal } from '@ci/common';
import { ENTITY_TYPE_REVERSE_MAP } from '@ci/common/src/constants';
import { Button, Sheet, Tooltip } from '@ci/shadcn';
import { ChartNetwork, Images, List, Map as MapIcon, type LucideIcon } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { FileChunkModal } from '@/components/modals/FileChunkModal/FileChunkModal';
import { AVAILABLE_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';

import { useEntityService } from '../MemoryPage/useEntityService';

import { ActivityTimelineRail } from './ActivityTimelineRail';
import { EntityDetails } from './Components/EntityDetails';
import {
  isRollingDatePreset,
  resolveDatePreset,
  type DatePreset,
} from './Components/ExplorerToolbar/datePresets';
import { ExplorerToolbar } from './Components/ExplorerToolbar/ExplorerToolbar';
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
        datePreset
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
  titleKey: string;
  Icon: LucideIcon;
}> = [
  { value: 'map', label: 'Map', titleKey: 'MEMORY_VIEW_MAP', Icon: MapIcon },
  { value: 'list', label: 'List', titleKey: 'MEMORY_VIEW_LIST', Icon: List },
  { value: 'gallery', label: 'Gallery', titleKey: 'MEMORY_VIEW_GALLERY', Icon: Images },
  { value: 'graph', label: 'Graph', titleKey: 'MEMORY_VIEW_GRAPH', Icon: ChartNetwork },
];

export default function DesktopMemoryPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [{ activeEntity }, { setActiveEntity }] = useEntityService();

  // Document chunks open in their own dialog; every other entity uses the
  // details sheet (EntityDetails has no FileChunkType branch).
  const activeChunkEntity = activeEntity?.__typename === 'FileChunkType' ? activeEntity : null;
  const activeSheetEntity =
    activeEntity != null && activeEntity.__typename !== 'FileChunkType' ? activeEntity : null;
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
  // Advanced filters render inside the header search panel and stay visible.
  // MemoryPage can derive the map's hasLocation scope from `?view=`.
  // Events is a What-bar filter, not a top-level view — rewrite legacy ?view=events.
  useEffect(() => {
    const view = searchParams.get('view');
    if (!view || view === 'events') {
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
        'when',
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

        if (isRollingDatePreset(filters.datePreset)) {
          currentParams.set('when', filters.datePreset);
          const { from, to } = resolveDatePreset(filters.datePreset as DatePreset);
          currentParams.set('from', from);
          currentParams.set('to', to);
        } else {
          if (filters.startTime) {
            currentParams.set('from', filters.startTime);
          }

          if (filters.endTime) {
            currentParams.set('to', filters.endTime);
          }

          if (filters.startTime || filters.endTime) {
            currentParams.set('when', 'custom');
          }
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

  return (
    <>
      {/* View tabs (list / map / gallery / graph) live in the header nav-views portal. */}
      <Portal.Slot id="nav-views">
        <div className="flex flex-wrap items-center gap-1">
          {VIEW_TABS.map(({ value, label, titleKey, Icon }) => {
            const title = t(titleKey);

            return (
              <Tooltip key={value} delayDuration={600}>
                <Tooltip.Content>{title}</Tooltip.Content>
                <Tooltip.Trigger asChild>
                  <Button
                    type="button"
                    variant={activeTab === value ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-label={title}
                    aria-pressed={activeTab === value}
                    onClick={() => setActiveTab(value)}
                    className="h-8 gap-1.5 px-2"
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.5} />
                    <span className="hidden sm:inline">{label}</span>
                  </Button>
                </Tooltip.Trigger>
              </Tooltip>
            );
          })}
        </div>
      </Portal.Slot>

      <PageContent className="gap-2 p-0">
        <MemoryHubShell fillHeight>
          <div className="flex min-h-0 flex-1 flex-col gap-2 pb-2">
            <div className="px-2">
              <ExplorerToolbar open />
            </div>
            {/* List view splits into two independently-scrolled panes: wheeling
              over the left rail moves the heatmap's window through time, while
              the result list on the right keeps its own scroll. */}
            {activeTab === 'list' && (
              <div className="flex min-h-0 flex-1">
                <ActivityTimelineRail className="shrink-0 border-r" />
                <ListView />
              </div>
            )}
            {activeTab === 'map' && <DesktopMapView />}
            {activeTab === 'gallery' && <GalleryView />}
            {activeTab === 'graph' && <GraphView variant="desktop" />}
          </div>
        </MemoryHubShell>
      </PageContent>

      {activeSheetEntity && (
        <Sheet open={detailsOpen} onOpenChange={toggleactiveEntity}>
          <EntityDetails entity={activeSheetEntity} />
        </Sheet>
      )}

      <FileChunkModal entity={activeChunkEntity} onClose={() => setActiveEntity(null)} />
    </>
  );
}
