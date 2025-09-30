import { useState, useEffect, useRef } from 'react';
import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Tabs, Card, Button, Input } from '@ci/shadcn';
import {
  Clock,
  Search,
  User,
  Calendar,
  FileText,
  MapPin,
  Loader2,
  AlertCircle,
  X,
} from '@ci/shadcn/icons';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';

// Types matching the backend Memory type
interface Memory {
  id: string;
  type: 'event' | 'content' | 'thing' | 'person' | 'contact';
  title: string;
  description: string | null;
  timestamp: string; // Will be converted from Date
  category: string;
  location?: MemoryLocation;
  tags: string[];
  userId: string;
  metadata?: {
    eventId?: string;
    eventType?: string;
    eventName?: string;
    synthetic?: boolean;
    personRef?: string;
    contentRef?: string;
    thingRef?: string;
    [key: string]: unknown;
  };
}

interface MemoryLocation {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
  address?: string;
  placeId?: string;
}

interface MemoryResponse {
  data: Memory[];
  total: number;
  limit: number;
  offset: number;
}

// Types for individual endpoints (if needed as fallback)
interface Event {
  id: string;
  name: string | null;
  type: string | null;
  description: string | null;
  start_time: string | null;
  end_time: string | null;
  external_id: string | null;
  source_url: string | null;
  source_data: object | null;
  user_id?: string;
  connection_id?: string;
}

interface Content {
  id: string;
  type: string;
  title: string | null;
  text: string | null;
  url: string | null;
  mimetype: string | null;
  external_id: string | null;
  source_url: string | null;
  user_id: string | null;
  event_id: string | null;
}

export default function MemoryPageReal() {
  usePageTitle('Memory - Companion Intelligence');
  const [{ authToken }] = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('list');
  const [totalMemories, setTotalMemories] = useState(0);
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Fetch memories from API
  const fetchMemories = async (query?: string) => {
    try {
      setLoading(true);
      setError(null);

      // Build query params
      const params = new URLSearchParams();
      if (query) {
        params.append('query', query);
      }
      params.append('limit', '50');

      // Fetch from the memory endpoint
      const memoryRes = await fetch(`/api/memory?${params}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });

      if (!memoryRes.ok) {
        const errorText = await memoryRes.text();
        console.error('Memory API error:', memoryRes.status, errorText);
        
        // If it's a 401, the user might not be authenticated
        if (memoryRes.status === 401) {
          throw new Error('You need to be logged in to view memories');
        }
        
        throw new Error(`Failed to fetch memories: ${memoryRes.status} ${errorText}`);
      }

      const memoryData: MemoryResponse = await memoryRes.json();
      console.log('Memory API response:', memoryData);

      // The backend returns a MemoryResponse object
      if (memoryData && memoryData.data) {
        setMemories(memoryData.data);
        setTotalMemories(memoryData.total);
      } else {
        setMemories([]);
        setTotalMemories(0);
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error fetching memories:', errorMessage, err);
      setError(errorMessage);
      
      // Try to fetch debug info if main endpoint fails
      try {
        const debugRes = await fetch('/api/memory/debug/direct', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (debugRes.ok) {
          const debugData = await debugRes.json();
          console.log('Debug data:', debugData);
        }
      } catch (debugErr) {
        console.error('Could not fetch debug data:', debugErr);
      }
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    if (authToken) {
      fetchMemories();
    }
  }, [authToken]);

  // Handle search
  const handleSearch = () => {
    fetchMemories(searchQuery);
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  // Get icon for memory type
  const getMemoryIcon = (type: Memory['type']) => {
    const iconClass = 'h-5 w-5';
    switch (type) {
      case 'event':
        return <Calendar className={iconClass} />;
      case 'content':
        return <FileText className={iconClass} />;
      case 'person':
        return <User className={iconClass} />;
      case 'contact':
        return <User className={iconClass} />;
      case 'thing':
        return <FileText className={iconClass} />;
      default:
        return <Clock className={iconClass} />;
    }
  };

  // Get memories with location for map
  const memoriesWithLocation = memories.filter((memory) => memory.location);

  // Initialize map when map tab is active
  useEffect(() => {
    if (activeTab !== 'map' || !mapContainerRef.current || memoriesWithLocation.length === 0) {
      return;
    }

    // Clean up existing map
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }

    // Fix Leaflet icon paths
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (L.Icon.Default.prototype as any)._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png',
      iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
    });

    // Initialize map
    const map = L.map(mapContainerRef.current);
    mapRef.current = map;

    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    // Add markers
    const bounds = L.latLngBounds([]);
    memoriesWithLocation.forEach((memory) => {
      if (memory.location) {
        const marker = L.marker([memory.location.lat, memory.location.lng])
          .addTo(map)
          .bindPopup(
            `
            <div class="p-2">
              <div class="font-semibold">${memory.title}</div>
              ${memory.description ? `<div class="text-sm mt-1">${memory.description}</div>` : ''}
              ${memory.location.address ? `<div class="text-xs text-gray-500 mt-1">${memory.location.address}</div>` : ''}
            </div>
          `,
          );
        bounds.extend([memory.location.lat, memory.location.lng]);
      }
    });

    // Fit map to bounds
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }

    // Add zoom control
    L.control.zoom({ position: 'bottomright' }).addTo(map);
  }, [activeTab, memoriesWithLocation]);

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
        <div className="space-y-6">
          {/* Search Bar */}
          <div className="flex gap-2">
            <div className="relative flex-1 max-w-2xl">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search memories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyPress}
                className="pl-10 pr-10"
                disabled={loading}
              />
              {searchQuery && (
                <button
                  className="absolute right-3 top-1/2 transform -translate-y-1/2"
                  onClick={() => setSearchQuery('')}
                >
                  <X className="h-5 w-5 text-muted-foreground" />
                </button>
              )}
            </div>
            <Button onClick={handleSearch} disabled={loading}>
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Search'}
            </Button>
          </div>

          {/* Error Display */}
          {error && (
            <Card className="bg-destructive/10 text-destructive">
              <Card.Content className="flex items-start gap-3 p-4">
                <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-medium">Error loading memories</h3>
                  <p className="text-sm">{error}</p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs">Debug Info</summary>
                    <pre className="text-xs mt-1 overflow-auto">{error}</pre>
                    <p className="text-xs mt-2">
                      Check the browser console for more details about available endpoints.
                    </p>
                  </details>
                </div>
              </Card.Content>
            </Card>
          )}

          {/* Loading State */}
          {loading && (
            <div className="flex justify-center items-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Content Tabs */}
          {!loading && !error && (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <Tabs.List>
                <Tabs.Trigger value="list">List</Tabs.Trigger>
                <Tabs.Trigger value="map">Map ({memoriesWithLocation.length})</Tabs.Trigger>
              </Tabs.List>

              <Tabs.Content value="list" className="mt-6">
                {memories.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">No memories found.</p>
                    {totalMemories > 0 && (
                      <p className="text-sm text-muted-foreground mt-2">
                        Total memories in database: {totalMemories}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Showing {memories.length} of {totalMemories} memories
                    </p>
                    {memories.map((memory) => (
                      <Card key={memory.id}>
                        <Card.Content className="p-4">
                          <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 p-2 bg-primary/10 rounded-full">
                              {getMemoryIcon(memory.type)}
                            </div>
                            <div className="flex-grow min-w-0">
                              <div className="flex justify-between items-start">
                                <h4 className="font-medium">{memory.title}</h4>
                                {memory.timestamp && (
                                  <time className="text-sm text-muted-foreground">
                                    {new Date(memory.timestamp).toLocaleDateString()}
                                  </time>
                                )}
                              </div>
                              {memory.description && (
                                <p className="text-sm text-muted-foreground mt-1">{memory.description}</p>
                              )}
                              <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                                <span className="capitalize">{memory.category || memory.type}</span>
                                {memory.location && (
                                  <span className="flex items-center gap-1">
                                    <MapPin className="h-3 w-3" />
                                    {memory.location.name || 'Location'}
                                  </span>
                                )}
                                {memory.metadata?.sourceUrl && (
                                  <a
                                    href={memory.metadata.sourceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hover:underline"
                                  >
                                    Source
                                  </a>
                                )}
                                {memory.metadata?.synthetic && (
                                  <span className="italic">Synthetic</span>
                                )}
                                {memory.tags.length > 0 && (
                                  <span>Tags: {memory.tags.join(', ')}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </Card.Content>
                      </Card>
                    ))}
                  </div>
                )}
              </Tabs.Content>

              <Tabs.Content value="map" className="mt-6">
                {memoriesWithLocation.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">No memories with location data.</p>
                  </div>
                ) : (
                  <div className="h-[600px] rounded-lg overflow-hidden border">
                    <div ref={mapContainerRef} className="h-full w-full" />
                  </div>
                )}
              </Tabs.Content>
            </Tabs>
          )}
        </div>
      </PageContent>
    </>
  );
}
