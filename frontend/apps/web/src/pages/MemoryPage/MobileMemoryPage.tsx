import { useState, useEffect } from 'react';

import { Tabs, Sheet } from '@ci/shadcn';
import { ChartNetwork, GanttChart, Images, List, Map as MapIcon } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { FileChunkModal } from '@/components/modals/FileChunkModal/FileChunkModal';
import { PullToRefresh } from '@/components/PullToRefresh';

import { useEntityService } from '../MemoryPage/useEntityService';

import { EntityDetails } from './Components';
import { ExplorerToolbar } from './Components/ExplorerToolbar/ExplorerToolbar';
import { applyViewFilterDefaults, readMemoryView } from './Components/ExplorerToolbar/viewFilterSupport';
import { GalleryView } from './GalleryView';
import { GraphView } from './GraphView';
import { ListView } from './ListView';
import { MobileMapView } from './MapView';
import { StoryTimelineView } from './StoryTimelineView';

export default function MobileMemoryPage() {
  const [{ activeEntity, refetch }, { setActiveEntity }] = useEntityService();

  // Document chunks open in their own dialog; every other entity uses the
  // details sheet (EntityDetails has no FileChunkType branch).
  const activeChunkEntity = activeEntity?.__typename === 'FileChunkType' ? activeEntity : null;
  const activeSheetEntity =
    activeEntity != null && activeEntity.__typename !== 'FileChunkType' ? activeEntity : null;
  const [searchParams, setSearchParams] = useSearchParams();

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
                  <Tabs.List className="grid w-full grid-cols-5">
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
                    <Tabs.Trigger
                      value="timeline"
                      className="flex items-center gap-1 px-1 text-[11px] sm:text-sm"
                    >
                      <GanttChart className="h-4 w-4" />
                      Timeline
                    </Tabs.Trigger>
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
                {activeTab === 'list' && <ListView />}

                {activeTab === 'map' && <MobileMapView />}

                {activeTab === 'timeline' && <StoryTimelineView />}

                {activeTab === 'gallery' && <GalleryView />}

                {activeTab === 'graph' && <GraphView variant="mobile" />}
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
