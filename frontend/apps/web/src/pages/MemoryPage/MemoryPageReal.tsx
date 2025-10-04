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

// Generate fake San Francisco events for today
function generateFakeSFEvents(): Memory[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  return [
    {
      id: 'fake-1',
      type: 'event',
      title: 'Morning Coffee at Blue Bottle',
      description: 'Started the day with a cappuccino',
      timestamp: new Date(today.getTime() + 8 * 60 * 60 * 1000).toISOString(), // 8 AM
      category: 'Coffee',
      location: {
        id: 'loc-1',
        name: 'Blue Bottle Coffee',
        lat: 37.7955,
        lng: -122.3937,
        address: '66 Mint St, San Francisco, CA',
      },
      tags: ['coffee', 'morning'],
      userId: 'demo-user',
    },
    {
      id: 'fake-2',
      type: 'event',
      title: 'Team Meeting at Office',
      description: 'Weekly standup with the engineering team',
      timestamp: new Date(today.getTime() + 9.5 * 60 * 60 * 1000).toISOString(), // 9:30 AM
      category: 'Work',
      location: {
        id: 'loc-2',
        name: 'Salesforce Tower',
        lat: 37.7897,
        lng: -122.3972,
        address: '415 Mission St, San Francisco, CA',
      },
      tags: ['work', 'meeting'],
      userId: 'demo-user',
    },
    {
      id: 'fake-3',
      type: 'event',
      title: 'Lunch at Ferry Building',
      description: 'Grabbed a sandwich at the marketplace',
      timestamp: new Date(today.getTime() + 12.5 * 60 * 60 * 1000).toISOString(), // 12:30 PM
      category: 'Food',
      location: {
        id: 'loc-3',
        name: 'Ferry Building Marketplace',
        lat: 37.7956,
        lng: -122.3933,
        address: '1 Ferry Building, San Francisco, CA',
      },
      tags: ['food', 'lunch'],
      userId: 'demo-user',
    },
    {
      id: 'fake-4',
      type: 'event',
      title: 'Walk through Embarcadero',
      description: 'Afternoon stroll along the waterfront',
      timestamp: new Date(today.getTime() + 13.5 * 60 * 60 * 1000).toISOString(), // 1:30 PM
      category: 'Recreation',
      location: {
        id: 'loc-4',
        name: 'Embarcadero Plaza',
        lat: 37.7946,
        lng: -122.3955,
        address: 'Embarcadero, San Francisco, CA',
      },
      tags: ['walking', 'outdoor'],
      userId: 'demo-user',
    },
    {
      id: 'fake-5',
      type: 'event',
      title: 'Coffee Meeting at Sightglass',
      description: 'Caught up with an old friend',
      timestamp: new Date(today.getTime() + 15 * 60 * 60 * 1000).toISOString(), // 3 PM
      category: 'Social',
      location: {
        id: 'loc-5',
        name: 'Sightglass Coffee',
        lat: 37.7749,
        lng: -122.4094,
        address: '270 7th St, San Francisco, CA',
      },
      tags: ['coffee', 'social'],
      userId: 'demo-user',
    },
    {
      id: 'fake-6',
      type: 'event',
      title: 'Shopping at Westfield',
      description: 'Picked up some new clothes',
      timestamp: new Date(today.getTime() + 16 * 60 * 60 * 1000).toISOString(), // 4 PM
      category: 'Shopping',
      location: {
        id: 'loc-6',
        name: 'Westfield San Francisco Centre',
        lat: 37.7847,
        lng: -122.4058,
        address: '865 Market St, San Francisco, CA',
      },
      tags: ['shopping', 'retail'],
      userId: 'demo-user',
    },
    {
      id: 'fake-7',
      type: 'event',
      title: 'Visit to SFMOMA',
      description: 'Checked out the new contemporary art exhibit',
      timestamp: new Date(today.getTime() + 17 * 60 * 60 * 1000).toISOString(), // 5 PM
      category: 'Art',
      location: {
        id: 'loc-7',
        name: 'San Francisco Museum of Modern Art',
        lat: 37.7857,
        lng: -122.4011,
        address: '151 3rd St, San Francisco, CA',
      },
      tags: ['art', 'museum'],
      userId: 'demo-user',
    },
    {
      id: 'fake-8',
      type: 'event',
      title: 'Dinner at Zuni Café',
      description: 'Amazing roast chicken and Caesar salad',
      timestamp: new Date(today.getTime() + 19 * 60 * 60 * 1000).toISOString(), // 7 PM
      category: 'Food',
      location: {
        id: 'loc-8',
        name: 'Zuni Café',
        lat: 37.7767,
        lng: -122.4233,
        address: '1658 Market St, San Francisco, CA',
      },
      tags: ['food', 'dinner'],
      userId: 'demo-user',
    },
    {
      id: 'fake-9',
      type: 'event',
      title: 'Drinks at Top of the Mark',
      description: 'Cocktails with a view',
      timestamp: new Date(today.getTime() + 20.5 * 60 * 60 * 1000).toISOString(), // 8:30 PM
      category: 'Entertainment',
      location: {
        id: 'loc-9',
        name: 'Top of the Mark',
        lat: 37.7919,
        lng: -122.4104,
        address: '999 California St, San Francisco, CA',
      },
      tags: ['drinks', 'social'],
      userId: 'demo-user',
    },
    {
      id: 'fake-10',
      type: 'event',
      title: 'Evening Walk at Coit Tower',
      description: 'Watched the sunset over the city',
      timestamp: new Date(today.getTime() + 21.5 * 60 * 60 * 1000).toISOString(), // 9:30 PM
      category: 'Recreation',
      location: {
        id: 'loc-10',
        name: 'Coit Tower',
        lat: 37.8024,
        lng: -122.4058,
        address: '1 Telegraph Hill Blvd, San Francisco, CA',
      },
      tags: ['walking', 'scenic'],
      userId: 'demo-user',
    },
  ];
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

      // Always start with fake SF events
      const fakeEvents = generateFakeSFEvents();

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
          console.log('Not authenticated, using only fake events');
          setMemories(fakeEvents);
          setTotalMemories(fakeEvents.length);
          setLoading(false);
          return;
        }
        
        // For other errors, still use fake events
        console.log('API error, using only fake events');
        setMemories(fakeEvents);
        setTotalMemories(fakeEvents.length);
        setLoading(false);
        return;
      }

      const memoryData: MemoryResponse = await memoryRes.json();
      console.log('Memory API response:', memoryData);

      // Combine fake events with real memories
      let combinedMemories: Memory[] = [...fakeEvents];
      
      if (memoryData && memoryData.data && memoryData.data.length > 0) {
        // Add real memories to the fake ones
        combinedMemories = [...fakeEvents, ...memoryData.data];
        console.log(`Combined ${fakeEvents.length} fake events with ${memoryData.data.length} real memories`);
      } else {
        console.log('No real memories from API, using only fake San Francisco events');
      }

      // Sort by timestamp (most recent first)
      combinedMemories.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      setMemories(combinedMemories);
      setTotalMemories(combinedMemories.length);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error fetching memories:', errorMessage, err);
      
      // On error, use fake data
      console.log('Error fetching memories, using fake San Francisco events');
      const fakeEvents = generateFakeSFEvents();
      setMemories(fakeEvents);
      setTotalMemories(fakeEvents.length);
      setError(null); // Don't show error since we have fake data
      
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
    if (activeTab !== 'map' || !mapContainerRef.current) {
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
      icon RetinaUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png',
      iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
    });

    // Default to San Francisco coordinates
    const defaultLat = 37.7749;
    const defaultLng = -122.4194;
    const defaultZoom = 13;

    // Initialize map centered on San Francisco (or first memory location if available)
    const centerLat = memoriesWithLocation.length > 0 ? memoriesWithLocation[0].location!.lat : defaultLat;
    const centerLng = memoriesWithLocation.length > 0 ? memoriesWithLocation[0].location!.lng : defaultLng;
    
    const map = L.map(mapContainerRef.current).setView([centerLat, centerLng], defaultZoom);
    mapRef.current = map;

    // Use satellite imagery
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: '',
        maxZoom: 20,
      },
    ).addTo(map);

    // Add markers if we have memories with location
    if (memoriesWithLocation.length > 0) {
      // Create custom icon for markers
      const customIcon = L.divIcon({
        className: 'custom-map-marker',
        html: `<div class="w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-md">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
            </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
      });

      const bounds = L.latLngBounds([]);
      const markers: L.Marker[] = [];

      // Sort memories by timestamp for timeline
      const sortedMemories = [...memoriesWithLocation].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      sortedMemories.forEach((memory, index) => {
        if (memory.location) {
          const marker = L.marker([memory.location.lat, memory.location.lng], { icon: customIcon })
            .addTo(map)
            .bindPopup(
              `
            <div class="p-3">
              <div class="font-bold text-lg mb-1">${memory.title}</div>
              <div class="text-sm mb-2 text-gray-600">${memory.description || 'No description'}</div>
              <div class="text-xs text-gray-500">${new Date(memory.timestamp).toLocaleString()}</div>
              <div class="mt-2 flex items-center gap-2">
                <span class="text-xs inline-block px-2 py-1 rounded-full bg-blue-100 text-blue-800">
                  ${memory.category}
                </span>
                <span class="text-xs text-gray-500">#${index + 1}</span>
              </div>
            </div>
          `,
              {
                className: 'custom-popup',
                maxWidth: 300,
                minWidth: 200,
                closeButton: true,
                autoClose: false,
              },
            );

          markers.push(marker);
          bounds.extend([memory.location.lat, memory.location.lng]);
        }
      });

      // Draw contrail line between all points
      if (markers.length > 1) {
        // Add numbered markers for timeline
        markers.forEach((marker, index) => {
          const numberIcon = L.divIcon({
            className: 'timeline-number-marker',
            html: `<div class="w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold shadow-md">
                  ${index + 1}
                </div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          });

          L.marker(marker.getLatLng(), { icon: numberIcon })
            .addTo(map)
            .bindTooltip(`Step ${index + 1}: ${sortedMemories[index].title}`, {
              permanent: false,
              direction: 'top',
              offset: [0, -10],
            });
        });

        // Create contrail line connecting all points
        const waypoints = markers.map((marker) => marker.getLatLng());
        L.polyline(waypoints, {
          color: '#3b82f6',
          weight: 4,
          opacity: 0.8,
          smoothFactor: 1,
        }).addTo(map);
      }

      // Fit bounds if we have markers
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50] });
      }
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
                      Showing {memories.length} memories (including 10 demo San Francisco events)
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
                                {memory.id.startsWith('fake-') && (
                                  <span className="text-blue-600 font-medium">Demo Event</span>
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
                <div className="h-[600px] rounded-lg overflow-hidden border">
                  <div ref={mapContainerRef} className="h-full w-full" />
                </div>
                {memoriesWithLocation.length > 0 && (
                  <p className="text-sm text-muted-foreground text-center mt-4">
                    Showing {memoriesWithLocation.length} locations (including demo San Francisco events)
                  </p>
                )}
              </Tabs.Content>
            </Tabs>
          )}
        </div>
      </PageContent>
    </>
  );
}
