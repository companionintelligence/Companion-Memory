import { useState, useEffect, useRef } from 'react';

import { Portal } from '@ci/common';
import { Button, Sheet, Tooltip } from '@ci/shadcn';
import {
  ChartNetwork,
  GanttChart,
  Images,
  List,
  Map as MapIcon,
  Plus,
  type LucideIcon,
} from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { AddEventModal } from '@/components/modals/AddItemModal';
import { FileChunkModal } from '@/components/modals/FileChunkModal/FileChunkModal';
import { useModalControls } from '@/hooks';

import { useEntityService } from '../MemoryPage/useEntityService';

import { ActivityTimelineRail } from './ActivityTimelineRail';
import { EntityDetails } from './Components/EntityDetails';
import { ExplorerToolbar } from './Components/ExplorerToolbar/ExplorerToolbar';
import { hasWhenFilter } from './Components/ExplorerToolbar/filterParams';
import { applyViewFilterDefaults, readMemoryView } from './Components/ExplorerToolbar/viewFilterSupport';
import { isEventsExplorer } from './explorerRoute';
import { ExploreView } from './ExploreView';
import { GalleryView } from './GalleryView';
import { GraphView } from './GraphView';
import { ListView } from './ListView';
import { DesktopMapView } from './MapView';
import { StoryTimelineView } from './StoryTimelineView';

const VIEW_TABS: Array<{
  value: string;
  label: string;
  titleKey: string;
  Icon: LucideIcon;
}> = [
  { value: 'map', label: 'Map', titleKey: 'MEMORY_VIEW_MAP', Icon: MapIcon },
  { value: 'list', label: 'List', titleKey: 'MEMORY_VIEW_LIST', Icon: List },
  { value: 'timeline', label: 'Timeline', titleKey: 'MEMORY_VIEW_TIMELINE', Icon: GanttChart },
  { value: 'gallery', label: 'Gallery', titleKey: 'MEMORY_VIEW_GALLERY', Icon: Images },
  { value: 'graph', label: 'Graph', titleKey: 'MEMORY_VIEW_GRAPH', Icon: ChartNetwork },
];

export default function DesktopMemoryPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [{ activeEntity, refetch }, { setActiveEntity }] = useEntityService();

  // Which list the List tab is: `/memory/events` is the chronology (ListView)
  // and always has the activity heatmap and the Timeline view; a bare
  // `/memory` is the ranked everything browse (ExploreView), which only
  // offers either once a When filter has made time part of the question (and
  // useExplorerWhenReset walks a stale `?view=timeline` back to List). See
  // explorerRoute.
  const eventsExplorer = isEventsExplorer(pathname);
  const timeInPlay = eventsExplorer || hasWhenFilter(searchParams);
  const viewTabs = timeInPlay ? VIEW_TABS : VIEW_TABS.filter((tab) => tab.value !== 'timeline');

  const [{ isOpen: isAddEventOpen }, { open: openAddEvent, close: closeAddEvent }] = useModalControls();

  // Document chunks open in their own dialog; every other entity uses the
  // details sheet (EntityDetails has no FileChunkType branch).
  const activeChunkEntity = activeEntity?.__typename === 'FileChunkType' ? activeEntity : null;
  const activeSheetEntity =
    activeEntity != null && activeEntity.__typename !== 'FileChunkType' ? activeEntity : null;
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The active view lives in the URL (`?view=`) so a query is shareable and
  // restores in the same view; list is the desktop default since it always
  // shows results (the map renders empty for data without coordinates).
  const activeTab = searchParams.get('view') ?? 'list';
  // Switching view never changes the filter set behind the user's back — the
  // one exception is the Map tab, which applies "Has a location" as a real,
  // chipped, removable filter (see applyViewFilterDefaults).
  const setActiveTab = (next: string) =>
    setSearchParams((params) => {
      const nextParams = new URLSearchParams(params);
      nextParams.set('view', next);

      return applyViewFilterDefaults(nextParams, readMemoryView(next));
    });
  // Advanced filters render inside the header search panel and stay visible.
  // Events is a What-bar filter, not a top-level view — rewrite legacy ?view=events. The view it
  // once addressed (`EventsView`, a TimelineView pinned to Event cards) was deleted: nothing had
  // rendered it since it was written, and this redirect is why. Old links keep landing on List.
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

  return (
    <>
      {/* View tabs (list / map / timeline / gallery / graph) live in the header nav-views portal. */}
      <Portal.Slot id="nav-views">
        <div className="flex flex-wrap items-center gap-1">
          {viewTabs.map(({ value, label, titleKey, Icon }) => {
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
        <MemoryHubShell
          actions={
            <Button size="sm" onClick={openAddEvent}>
              <Plus className="h-4 w-4" />
              New event
            </Button>
          }
          fillHeight
        >
          <div className="flex min-h-0 flex-1 flex-col gap-2 pb-2">
            <div className="px-2">
              <ExplorerToolbar open />
            </div>
            {/* With the heatmap showing, the List tab splits into two
              independently-scrolled panes: wheeling over the left rail moves
              the heatmap's window through time, while the result list on the
              right keeps its own scroll. */}
            {activeTab === 'list' && (
              <div className="flex min-h-0 flex-1">
                {timeInPlay && <ActivityTimelineRail className="shrink-0 border-r" />}
                {eventsExplorer ? <ListView /> : <ExploreView />}
              </div>
            )}
            {activeTab === 'map' && <DesktopMapView />}
            {activeTab === 'timeline' && <StoryTimelineView />}
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

      {/* The explorer reads a `search` connection whose contents the server
          composes per query — there is no cache entry a new event can be
          appended to, so refetch the browse instead. */}
      <AddEventModal open={isAddEventOpen} onClose={closeAddEvent} onCreated={refetch} />
    </>
  );
}
