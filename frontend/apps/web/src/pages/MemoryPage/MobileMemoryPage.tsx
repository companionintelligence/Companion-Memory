import { useState, useEffect } from 'react';

import { Portal } from '@ci/common';
import { Breadcrumb, Tabs, Sheet } from '@ci/shadcn';
import { ChartNetwork, Images, List, Map as MapIcon } from '@ci/shadcn/icons';
import { Link, useSearchParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';

import { useEntityService } from '../MemoryPage/useEntityService';

import { EntityDetails } from './Components';
import {
  AdvancedSearchToggle,
  ExplorerToolbar,
  MemorySearchField,
} from './Components/ExplorerToolbar/ExplorerToolbar';
import { GalleryView } from './GalleryView';
import { GraphView } from './GraphView';
import { ListView } from './ListView';
import { MobileMapView } from './MapView';

export default function MobileMemoryPage() {
  const [{ activeEntity }, { setActiveEntity }] = useEntityService();
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
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Reflect the default view in the URL so the query is shareable/restorable.
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
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item>
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Memory</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <div className="space-y-3">
          {/* The global header search isn't shown on mobile, so the search field
              lives here inline, next to the Advanced toggle; the advanced drawer
              (Who/What/When/Where/How + tags, semantic, sort, save), chips and
              result count render below via the shared ExplorerToolbar. */}
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <MemorySearchField />
            </div>
            <AdvancedSearchToggle open={advancedOpen} onToggle={() => setAdvancedOpen((open) => !open)} />
          </div>
          <ExplorerToolbar open={advancedOpen} />

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
      </PageContent>
      {activeEntity && (
        <Sheet open={detailsOpen} onOpenChange={toggleactiveEntity}>
          <EntityDetails entity={activeEntity} />
        </Sheet>
      )}
    </>
  );
}
