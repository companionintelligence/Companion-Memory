import { useState, useEffect } from 'react';

import { Portal } from '@ci/common';
import { Breadcrumb, Tabs, Sheet } from '@ci/shadcn';
import { MapPin, List, Images, Share2 } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';

import { useEntityService } from '../MemoryPage/useEntityService';

import { EntityDetails } from './Components';
import { ExplorerToolbar } from './Components/ExplorerToolbar/ExplorerToolbar';
import { GalleryView } from './GalleryView';
import { GraphView } from './GraphView';
import { MobileMapView } from './MapView';
import { TimelineView } from './TimelineView';

export default function MobileMemoryPage() {
  const [{ activeEntity }, { setActiveEntity }] = useEntityService();

  const [activeTab, setActiveTab] = useState('list');
  const [detailsOpen, setDetailsOpen] = useState(false);

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
          {/* The same explorer search + filter toolbar as desktop, so the two
              stay in sync and the URL params (search / filters / semantic) are
              written non-destructively. The global header search isn't shown on
              mobile, so this is the primary search surface here. */}
          <ExplorerToolbar />

          {/* Tab Navigation */}
          <Tabs defaultValue="list" onValueChange={setActiveTab} value={activeTab}>
            <Tabs.List className="grid grid-cols-4 w-full">
              <Tabs.Trigger value="list" className="text-sm flex items-center gap-1">
                <List className="h-4 w-4" />
                List
              </Tabs.Trigger>
              <Tabs.Trigger value="map" className="text-sm flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                Map
              </Tabs.Trigger>
              <Tabs.Trigger value="gallery" className="text-sm flex items-center gap-1">
                <Images className="h-4 w-4" />
                Gallery
              </Tabs.Trigger>
              <Tabs.Trigger value="graph" className="text-sm flex items-center gap-1">
                <Share2 className="h-4 w-4" />
                Graph
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </div>

        {/* Content */}
        <>
          {activeTab === 'list' && <TimelineView />}

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
