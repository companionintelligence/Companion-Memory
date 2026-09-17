import { useState, useEffect } from 'react';

import { Tabs, Sheet } from '@ci/shadcn';
import { ChartNetwork, GanttChart, Images, List, Map as MapIcon } from '@ci/shadcn/icons';
import { useLocation, useSearchParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { FileChunkModal } from '@/components/modals/FileChunkModal/FileChunkModal';
import { PullToRefresh } from '@/components/PullToRefresh';

import { useEntityService } from '../MemoryPage/useEntityService';

import { EntityDetails } from './Components';
import { ExplorerToolbar } from './Components/ExplorerToolbar/ExplorerToolbar';
import { hasWhenFilter } from './Components/ExplorerToolbar/filterParams';
import { applyViewFilterDefaults, readMemoryView } from './Components/ExplorerToolbar/viewFilterSupport';
import { LazyView, type ViewLoader } from './Components/LazyView';
import { isEventsExplorer } from './explorerRoute';
import { ExploreView } from './ExploreView';
import { ListView } from './ListView';

// Only List is bundled with the page — it is the default view, so lazy-loading
// it would put a skeleton flash on the common path. The other four each drag in
// a heavy dependency (leaflet, TimelineJS, force-graph + d3-force), which the
// list-view visitor used to download without ever rendering — and on a phone
// that is the connection least able to afford it.
//
// These are loaders, not lazy components: LazyView mints the React.lazy itself,
// so it can mint a fresh one on retry — a rejected lazy payload re-throws the
// same error forever, which would leave "Try again" permanently inert.
const loadMapView: ViewLoader = () => import('./MapView').then((m) => ({ default: m.MobileMapView }));
const loadStoryTimelineView: ViewLoader = () =>
  import('./StoryTimelineView').then((m) => ({ default: m.StoryTimelineView }));
const loadGalleryView: ViewLoader = () => import('./GalleryView').then((m) => ({ default: m.GalleryView }));
const loadGraphView: ViewLoader = () =>
  import('./GraphView').then((m) => {
    // LazyView renders its component with no props, so bind the variant here.
    const MobileGraphView = () => <m.GraphView variant="mobile" />;

    return { default: MobileGraphView };
  });

export default function MobileMemoryPage() {
  const [{ activeEntity, refetch }, { setActiveEntity }] = useEntityService();

  // Document chunks open in their own dialog; every other entity uses the
  // details sheet (EntityDetails has no FileChunkType branch).
  const activeChunkEntity = activeEntity?.__typename === 'FileChunkType' ? activeEntity : null;
  const activeSheetEntity =
    activeEntity != null && activeEntity.__typename !== 'FileChunkType' ? activeEntity : null;
  const [searchParams, setSearchParams] = useSearchParams();
  // `/memory/events` lists a chronology; a bare `/memory` lists everything by
  // relevance (see explorerRoute and ExploreView), and offers the Timeline
  // view only once a When filter is in place.
  const { pathname } = useLocation();
  const eventsExplorer = isEventsExplorer(pathname);
  const showTimelineView = eventsExplorer || hasWhenFilter(searchParams);

  // The active view lives in the URL (`?view=`) so a query is shareable and
  // restores in the same view; list is the mobile default.
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
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Reflect the default view in the URL so the query is shareable/restorable.
  // Events is a What-bar filter, not a top-level view — rewrite legacy ?view=events. The view it
  // once addressed (`EventsView`) was deleted as dead code; old links keep landing on List.
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

  const toggleactiveEntity = (active: boolean) => {
    if (!active) {
      setActiveEntity(null);
    }
  };

  useEffect(() => {
    setDetailsOpen(activeEntity != null);
  }, [activeEntity]);

  return (
    <>
      <PullToRefresh onRefresh={refetch}>
        <PageContent className="gap-2 p-0">
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-2">
            {/* Search and Add live in MobileTopBar — same unified header as
              desktop, so this page does not render a second search box or
              a type-specific create button. */}
            <MemoryHubShell fillHeight>
              <div className="space-y-2">
                <ExplorerToolbar open />

                {/* Tab Navigation */}
                <Tabs defaultValue="list" onValueChange={setActiveTab} value={activeTab}>
                  <Tabs.List
                    className={showTimelineView ? 'grid w-full grid-cols-5' : 'grid w-full grid-cols-4'}
                  >
                    <Tabs.Trigger
                      value="list"
                      className="flex items-center gap-1 px-1 text-[11px] sm:text-sm"
                    >
                      <List className="h-4 w-4" />
                      List
                    </Tabs.Trigger>
                    <Tabs.Trigger value="map" className="flex items-center gap-1 px-1 text-[11px] sm:text-sm">
                      <MapIcon className="h-4 w-4" />
                      Map
                    </Tabs.Trigger>
                    {showTimelineView && (
                      <Tabs.Trigger
                        value="timeline"
                        className="flex items-center gap-1 px-1 text-[11px] sm:text-sm"
                      >
                        <GanttChart className="h-4 w-4" />
                        Timeline
                      </Tabs.Trigger>
                    )}
                    <Tabs.Trigger
                      value="gallery"
                      className="flex items-center gap-1 px-1 text-[11px] sm:text-sm"
                    >
                      <Images className="h-4 w-4" />
                      Gallery
                    </Tabs.Trigger>
                    <Tabs.Trigger
                      value="graph"
                      className="flex items-center gap-1 px-1 text-[11px] sm:text-sm"
                    >
                      <ChartNetwork className="h-4 w-4" />
                      Graph
                    </Tabs.Trigger>
                  </Tabs.List>
                </Tabs>
              </div>

              {/* Content */}
              <>
                {activeTab === 'list' && (eventsExplorer ? <ListView /> : <ExploreView />)}

                {activeTab === 'map' && <LazyView viewKey="map" load={loadMapView} />}

                {activeTab === 'timeline' && <LazyView viewKey="timeline" load={loadStoryTimelineView} />}

                {activeTab === 'gallery' && <LazyView viewKey="gallery" load={loadGalleryView} />}

                {activeTab === 'graph' && <LazyView viewKey="graph" load={loadGraphView} />}
              </>
            </MemoryHubShell>
          </div>
        </PageContent>
      </PullToRefresh>
      {activeSheetEntity && (
        <Sheet open={detailsOpen} onOpenChange={toggleactiveEntity}>
          <EntityDetails entity={activeSheetEntity} />
        </Sheet>
      )}

      <FileChunkModal entity={activeChunkEntity} onClose={() => setActiveEntity(null)} />
    </>
  );
}
