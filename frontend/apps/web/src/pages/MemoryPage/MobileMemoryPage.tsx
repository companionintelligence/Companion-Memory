import { useState, useEffect } from 'react';

import { Tabs, Sheet } from '@ci/shadcn';
import { ChartNetwork, Images, List, Map as MapIcon } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { FileChunkModal } from '@/components/modals/FileChunkModal/FileChunkModal';

import { useEntityService } from '../MemoryPage/useEntityService';

import { EntityDetails } from './Components';
import { ExplorerToolbar, MemorySearchField } from './Components/ExplorerToolbar/ExplorerToolbar';
import { countActiveFilters } from './Components/ExplorerToolbar/filterParams';
import { GalleryView } from './GalleryView';
import { GraphView } from './GraphView';
import { ListView } from './ListView';
import { MobileMapView } from './MapView';

export default function MobileMemoryPage() {
  const [{ activeEntity }, { setActiveEntity }] = useEntityService();

  // Document chunks open in their own dialog; every other entity uses the
  // details sheet (EntityDetails has no FileChunkType branch).
  const activeChunkEntity = activeEntity?.__typename === 'FileChunkType' ? activeEntity : null;
  const activeSheetEntity =
    activeEntity != null && activeEntity.__typename !== 'FileChunkType' ? activeEntity : null;
  const [searchParams, setSearchParams] = useSearchParams();

  // The active view lives in the URL (`?view=`) so a query is shareable and
  // restores in the same view; list is the mobile default.
  const activeTab = searchParams.get('view') ?? 'list';
  const setActiveTab = (next: string) =>
    setSearchParams((params) => {
      const nextParams = new URLSearchParams(params);
      nextParams.set('view', next);

      return nextParams;
    });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const activeFilterCount = countActiveFilters(searchParams);

  // Reflect the default view in the URL so the query is shareable/restorable.
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
      <PageContent className="gap-2 p-0">
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-2">
          {/* The global header search isn't shown on mobile — keep it first, like
              the desktop header, above entity-type nav and filters. */}
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <MemorySearchField />
            </div>
            {activeFilterCount > 0 && (
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'}
              </span>
            )}
          </div>

          <MemoryHubShell fillHeight>
            <div className="space-y-2">
              <ExplorerToolbar open />

              {/* Tab Navigation */}
              <Tabs defaultValue="list" onValueChange={setActiveTab} value={activeTab}>
                <Tabs.List className="grid grid-cols-4 w-full">
                  <Tabs.Trigger value="list" className="text-sm flex items-center gap-1">
                    <List className="h-4 w-4" />
                    List
                  </Tabs.Trigger>
                  <Tabs.Trigger value="map" className="text-sm flex items-center gap-1">
                    <MapIcon className="h-4 w-4" />
                    Map
                  </Tabs.Trigger>
                  <Tabs.Trigger value="gallery" className="text-sm flex items-center gap-1">
                    <Images className="h-4 w-4" />
                    Gallery
                  </Tabs.Trigger>
                  <Tabs.Trigger value="graph" className="text-sm flex items-center gap-1">
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

              {activeTab === 'gallery' && <GalleryView />}

              {activeTab === 'graph' && <GraphView variant="mobile" />}
            </>
          </MemoryHubShell>
        </div>
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
