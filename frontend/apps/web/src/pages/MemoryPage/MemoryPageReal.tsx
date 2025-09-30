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

// Types based on your backend
interface MemoryEvent {
  id: string;
  type: string | null;
  name: string | null;
  description: string | null;
  start_time: string | null;
  end_time: string | null;
  external_id: string | null;
  source_url: string | null;
  source_data: Record<string, unknown> | null;
  location?: {
    id: string;
    name: string | null;
    lat: number;
    lng: number;
    address?: string;
  };
}

interface MemoryContent {
  id: string;
  type: string | null;
  title: string | null;
  text: string | null;
  url: string | null;
  mimetype: string | null;
  external_id: string | null;
  source_url: string | null;
  event?: {
    id: string;
  };
}

interface MemoryContact {
  id: string;
  type: string | null;
  avatar_url: string | null;
  // Add other fields based on ContactEntity
}

interface MemoryPerson {
  id: string;
  type: string | null;
  first_name: string | null;
  last_name: string | null;
  // Add other fields based on PersonEntity
}

interface MemoryPlace {
  id: string;
  type: string | null;
  name: string | null;
  // Add other fields based on PlaceEntity
}

interface MemoryLocation {
  id: string;
  identifier: string | null;
  datetime: string | null;
  // Add other fields based on LocationEntity
}

// Unified memory item for display
interface MemoryItem {
  id: string;
  type: 'event' | 'content' | 'person' | 'place';
  title: string;
  description: string | null;
  timestamp: string | null;
  location?: {
    lat: number;
    lng: number;
    name: string | null;
    address?: string;
  };
  sourceUrl?: string | null;
  externalId?: string | null;
}

export default function MemoryPageReal() {
  usePageTitle('Memory - Companion Intelligence');
  const [{ authToken }] = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('list');
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Convert backend data to unified memory items
  const convertToMemoryItems = (
    events: MemoryEvent[],
    content: MemoryContent[],
    contacts: MemoryContact[],
    people: MemoryPerson[],
    places: MemoryPlace[],
    locations: MemoryLocation[],
  ): MemoryItem[] => {
    const items: MemoryItem[] = [];

    // Convert events
    events.forEach((event) => {
      items.push({
        id: event.id,
        type: 'event',
        title: event.name || 'Untitled Event',
        description: event.description,
        timestamp: event.start_time,
        sourceUrl: event.source_url,
        externalId: event.external_id,
        location: event.location
          ? {
              lat: event.location.lat,
              lng: event.location.lng,
              name: event.location.name,
              address: event.location.address,
            }
          : undefined,
      });
    });

    // Convert content
    content.forEach((item) => {
      items.push({
        id: item.id,
        type: 'content',
        title: item.title || 'Untitled Content',
        description: item.text,
        timestamp: null,
        sourceUrl: item.source_url,
        externalId: item.external_id,
      });
    });

    // Convert people
    people.forEach((person) => {
      const fullName = [person.first_name, person.last_name].filter(Boolean).join(' ');
      items.push({
        id: person.id,
        type: 'person',
        title: fullName || 'Unknown Person',
        description: [person.email, person.phone].filter(Boolean).join(' • '),
        timestamp: null,
        sourceUrl: person.source_url,
        externalId: person.external_id,
      });
    });

    // Convert places
    places.forEach((place) => {
      items.push({
        id: place.id,
        type: 'place',
        title: place.name || 'Unknown Place',
        description: null,
        timestamp: null,
        sourceUrl: null,
        externalId: null,
      });
    });

    return items;
  };

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

      // Try different possible API endpoints
      // First, let's try to fetch from a general memory endpoint
      try {
        const memoryRes = await fetch(`/api/memory?${params}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });

        if (memoryRes.ok) {
          const memoryData = await memoryRes.json();
          console.log('Memory API response:', memoryData);
          
          // Handle the response based on its structure
          if (Array.isArray(memoryData)) {
            // If it's an array, convert directly
            setMemories(memoryData);
          } else if (memoryData.events || memoryData.content || memoryData.contacts) {
            // If it's an object with different types
            const items = convertToMemoryItems(
              memoryData.events || [],
              memoryData.content || [],
              memoryData.contacts || [],
              memoryData.people || [],
              memoryData.places || [],
              memoryData.locations || [],
            );
            setMemories(items);
          } else {
            // Empty or unexpected format
            setMemories([]);
          }
          return;
        }
      } catch (e) {
        console.log('General memory endpoint not available, trying individual endpoints...');
      }

      // If general endpoint fails, try individual endpoints with different naming conventions
      const endpoints = [
        { name: 'events', path: '/api/events' },
        { name: 'content', path: '/api/content' },
        { name: 'contacts', path: '/api/contacts' },
        { name: 'people', path: '/api/people' },
        { name: 'places', path: '/api/places' },
        { name: 'locations', path: '/api/locations' },
      ];

      const results: Record<string, any> = {};
      const errors: string[] = [];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(`${endpoint.path}?${params}`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          
          if (res.ok) {
            results[endpoint.name] = await res.json();
            console.log(`${endpoint.name} data:`, results[endpoint.name]);
          } else {
            const text = await res.text();
            console.log(`${endpoint.name} endpoint not available: ${res.status} - ${text}`);
          }
        } catch (e) {
          console.log(`Error fetching ${endpoint.name}:`, e);
        }
      }

      // If we got any data, convert it
      if (Object.keys(results).length > 0) {
        const items = convertToMemoryItems(
          results.events || [],
          results.content || [],
          results.contacts || [],
          results.people || [],
          results.places || [],
          results.locations || [],
        );
        setMemories(items);
      } else {
        // No endpoints worked
        throw new Error('Unable to fetch memory data. Please check the API endpoints.');
      }

      // Sort by timestamp (newest first)
      items.sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      setMemories(items);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error fetching memories:', errorMessage, err);
      setError(errorMessage);
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
  const getMemoryIcon = (type: MemoryItem['type']) => {
    const iconClass = 'h-5 w-5';
    switch (type) {
      case 'event':
        return <Calendar className={iconClass} />;
      case 'content':
        return <FileText className={iconClass} />;
      case 'person':
        return <User className={iconClass} />;
      case 'place':
        return <MapPin className={iconClass} />;
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
                  </div>
                ) : (
                  <div className="space-y-4">
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
                                <span className="capitalize">{memory.type}</span>
                                {memory.location && (
                                  <span className="flex items-center gap-1">
                                    <MapPin className="h-3 w-3" />
                                    {memory.location.name || 'Location'}
                                  </span>
                                )}
                                {memory.sourceUrl && (
                                  <a
                                    href={memory.sourceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hover:underline"
                                  >
                                    Source
                                  </a>
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
