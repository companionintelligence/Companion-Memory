import { useState, useEffect, useRef } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, Portal } from '@ci/common';
import { ENTITY_TYPE_REVERSE_MAP } from '@ci/common/src/constants';
import { Breadcrumb, Tabs, Sheet } from '@ci/shadcn';
import { MapPin, List, Images, Share2 } from '@ci/shadcn/icons';
import { useSearchParams, Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { AVAILABLE_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';

import { useEntityService } from '../MemoryPage/useEntityService';

import { EntityDetails } from './Components/EntityDetails';
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
    }
  }
`);

export default function DesktopMemoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [{ activeEntity }, { setActiveEntity }] = useEntityService();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchId, setSearchId] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState('map');

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

      <PageContent className="p-0 gap-0">
        <div className="flex items-start gap-2 p-4">
          {/* Always-visible explorer toolbar: search + when + sort + a Filters
              toggle that reveals the full LifeScope-parity filter set, with an
              active-filter chip row and result count. */}
          <div className="flex-1">
            <ExplorerToolbar />
          </div>

          {/* View Toggle. Native `title` for the hover label rather than a Radix
              Tooltip: wrapping Tabs.Trigger in Tooltip.Trigger renders a button
              inside a button (invalid HTML + hydration error), and merging them
              (asChild) makes the tooltip's data-state clobber the tab's
              active/inactive state, killing the active-tab highlight. */}
          <Tabs defaultValue="map" onValueChange={setActiveTab} value={activeTab}>
            <Tabs.List className="flex items-center justify-center h-11.5 border-1">
              <Tabs.Trigger value="map" title="Map view" className="flex items-center justify-center h-4 w-6">
                <MapPin />
              </Tabs.Trigger>
              <Tabs.Trigger
                value="list"
                title="List view"
                className="flex items-center justify-center h-4 w-6"
              >
                <List />
              </Tabs.Trigger>
              <Tabs.Trigger
                value="gallery"
                title="Gallery view"
                className="flex items-center justify-center h-4 w-6"
              >
                <Images />
              </Tabs.Trigger>
              <Tabs.Trigger
                value="graph"
                title="Graph view"
                className="flex items-center justify-center h-4 w-6"
              >
                <Share2 />
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </div>

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
