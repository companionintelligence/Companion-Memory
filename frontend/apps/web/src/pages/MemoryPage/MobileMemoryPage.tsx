import { useState, useEffect } from 'react';

import { Portal } from '@ci/common';
import { Breadcrumb, Tabs, Select, Button, Sheet } from '@ci/shadcn';
import { Search, Filter, MapPin, List, Images, X, Workflow, Share2 } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';

import { MemoryDetails } from './Components';
import { GalleryView } from './GalleryView';
import { GraphView } from './GraphView';
import { MobileMapView } from './MapView';
import { TimelineView } from './TimelineView';
import { useMemoryService } from './useMemoryService';

export default function MobileMemoryPage() {
  const { searchQuery, setSearchQuery, activeMemory, setActiveMemory } = useMemoryService();
  const [, setSearchParams] = useSearchParams();

  const [activeTab, setActiveTab] = useState('list');

  // Mobile-specific states
  const [showFilters, setShowFilters] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Handle search
  const handleSearch = () => {
    // Update URL with search query
    if (searchQuery.trim()) {
      setSearchParams({ search: searchQuery.trim() });
    } else {
      setSearchParams({});
    }
    // Search is automatically triggered when searchQuery changes in MemoryProvider
  };

  const handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);

    // If the input is cleared, also clear the URL
    if (!value.trim()) {
      setSearchParams({});
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const toggleActiveMemory = (active: boolean) => {
    if (!active) {
      setActiveMemory(null);
    }
  };

  useEffect(() => {
    setDetailsOpen(activeMemory != null);
  }, [activeMemory]);

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item>
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Memory</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Mobile Header with Search and Filters */}
        <div className="space-y-3">
          {/* Search Bar */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <Search className="h-5 w-5 text-muted-foreground" />
            </div>
            <input
              type="search"
              className="block w-full p-3 pl-10 text-base border rounded-lg bg-background border-input text-foreground placeholder:text-muted-foreground"
              placeholder="Search memories..."
              value={searchQuery}
              onChange={handleSearchInputChange}
              onKeyDown={handleKeyPress}
            />
            {searchQuery && (
              <button
                className="absolute inset-y-0 right-0 flex items-center pr-3"
                onClick={() => setSearchQuery('')}
              >
                <X className="h-5 w-5 text-muted-foreground" />
              </button>
            )}
          </div>

          {/* Mobile Tab Navigation */}
          <div className="flex items-center justify-between">
            <Tabs defaultValue="list" className="flex-1" onValueChange={setActiveTab} value={activeTab}>
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
                <Tabs.Trigger value="graph" className="text-sm flex items-center gap-1">
                  <Workflow className="h-4 w-4" />
                  Graph
                </Tabs.Trigger>
              </Tabs.List>
            </Tabs>

            {/* Filter Toggle */}
            <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)} className="ml-2">
              <Filter className="h-4 w-4" />
            </Button>
          </div>

          {/* Mobile Filters */}
          {showFilters && (
            <div className="space-y-3 p-3 bg-muted/50 rounded-lg">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium mb-1 block">Type</label>
                  <Select value="all" disabled>
                    <Select.Trigger className="w-full h-9 text-sm">
                      <Select.Value placeholder="All Entity Types" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="all">All Entity Types</Select.Item>
                    </Select.Content>
                  </Select>
                </div>

                <div>
                  <label className="text-sm font-medium mb-1 block">Connection</label>
                  <Select value="all" disabled>
                    <Select.Trigger className="w-full h-9 text-sm">
                      <Select.Value placeholder="All Connections" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="all">All Connections</Select.Item>
                    </Select.Content>
                  </Select>
                </div>
              </div>

              {activeTab === 'map' && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Memories with locations</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Error Display */}
        {/* Content */}
        <>
          {activeTab === 'list' && <TimelineView />}

          {activeTab === 'map' && <MobileMapView />}

          {activeTab === 'gallery' && <GalleryView />}

          {activeTab === 'graph' && <GraphView variant="mobile" />}
        </>
      </PageContent>
      {activeMemory && (
        <Sheet open={detailsOpen} onOpenChange={toggleActiveMemory}>
          <MemoryDetails memory={activeMemory} />
        </Sheet>
      )}
    </>
  );
}
