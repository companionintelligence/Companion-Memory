import { useState, useEffect, useRef } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Separator, Tabs, Card } from '@ci/shadcn';
import {
  Clock,
  Coffee,
  Search,
  ShoppingCart,
  Utensils,
  BookOpen,
  Dumbbell,
  Car,
  Laptop,
  Tv,
  User,
  MapPin,
  Calendar,
  FileText,
  Package,
  Users,
  Phone,
  Loader2,
  AlertCircle,
} from '@ci/shadcn/icons';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';

// Add custom styles for Leaflet
import './memory-map.css';

// Memory data from API
interface MemoryItem {
  id: string;
  type: 'event' | 'content' | 'thing' | 'person' | 'contact';
  title: string;
  description: string | null;
  timestamp: string;
  category: string;
  location?: {
    id: string;
    name: string | null;
    lat: number;
    lng: number;
    address?: string;
  };
  tags: string[];
  userId: string;
  metadata?: Record<string, unknown>;
}

interface MemoryResponse {
  data: MemoryItem[];
  total: number;
  limit: number;
  offset: number;
}

// Helper function to get icon for memory type/category
function getMemoryIcon(memory: MemoryItem): React.ReactNode {
  const iconClass = 'h-5 w-5';

  // First check by type
  switch (memory.type) {
    case 'person':
      return <User className={iconClass} />;
    case 'contact':
      return <Phone className={iconClass} />;
    case 'thing':
      return <Package className={iconClass} />;
    case 'content':
      return <FileText className={iconClass} />;
  }

  // Then check by category for events
  const category = memory.category.toLowerCase();
  if (category.includes('food') || category.includes('drink') || category.includes('meal')) {
    return <Utensils className={iconClass} />;
  } else if (category.includes('coffee')) {
    return <Coffee className={iconClass} />;
  } else if (category.includes('work') || category.includes('meeting')) {
    return <Laptop className={iconClass} />;
  } else if (category.includes('fitness') || category.includes('gym') || category.includes('exercise')) {
    return <Dumbbell className={iconClass} />;
  } else if (category.includes('shopping') || category.includes('grocery')) {
    return <ShoppingCart className={iconClass} />;
  } else if (category.includes('learning') || category.includes('reading') || category.includes('book')) {
    return <BookOpen className={iconClass} />;
  } else if (category.includes('family') || category.includes('social')) {
    return <Users className={iconClass} />;
  } else if (category.includes('transport') || category.includes('drive') || category.includes('car')) {
    return <Car className={iconClass} />;
  } else if (category.includes('entertainment') || category.includes('tv') || category.includes('movie')) {
    return <Tv className={iconClass} />;
  } else if (category.includes('event')) {
    return <Calendar className={iconClass} />;
  }

  // Default icon
  return <Clock className={iconClass} />;
}

export function MemoryPage() {
  usePageTitle('Memory - Companion Intelligence');
  const [{ authToken }] = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('map');
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Fetch memories from API
  const fetchMemories = async (query?: string) => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (query) {
        params.append('query', query);
      }

      params.append('limit', '100');

      console.log('MemoryPage: Fetching memories', {
        query,
        authToken: authToken ? 'present' : 'missing',
        url: `/api/memory?${params.toString()}`,
      });

      const response = await fetch(`/api/memory?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      console.log('MemoryPage: Response status', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('MemoryPage: Error response', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(`Failed to fetch memories: ${response.statusText} - ${errorText}`);
      }

      const data: MemoryResponse = await response.json();
      console.log('MemoryPage: Received data', {
        dataLength: data.data.length,
        total: data.total,
        firstItem: data.data[0],
      });

      // Convert timestamp strings to Date strings for proper display
      const memoriesWithDates = data.data.map((memory) => ({
        ...memory,
        timestamp:
          typeof memory.timestamp === 'string' ? memory.timestamp : new Date(memory.timestamp).toISOString(),
      }));

      setMemories(memoriesWithDates);
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
    fetchMemories();
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

  // Get memories with location data for the map
  const memoriesWithLocation = memories.filter((memory) => memory.location);

  // Initialize and update map when the tab changes or filtered memories change
  useEffect(() => {
    if (activeTab !== 'map' || !mapContainerRef.current) {
      return;
    }

    // Fix for Leaflet's icon paths
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (L.Icon.Default.prototype as any)._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png',
      iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
    });

    // When switching tabs, we need to destroy and recreate the map
    // This fixes the issue with the map not appearing when switching back to the tab
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }

    // Initialize map
    mapRef.current = L.map(mapContainerRef.current).setView([37.7749, -122.4194], 12);

    // Use a more modern map style
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(mapRef.current);

    // Clear existing markers
    mapRef.current.eachLayer((layer) => {
      if (layer instanceof L.Marker) {
        mapRef.current?.removeLayer(layer);
      }
    });

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

    // Add markers for memories with location
    const bounds = L.latLngBounds([]);
    memoriesWithLocation.forEach((memory) => {
      if (memory.location) {
        L.marker([memory.location.lat, memory.location.lng], { icon: customIcon })
          .addTo(mapRef.current!)
          .bindPopup(
            `
            <div class="p-2">
              <div class="font-bold text-lg mb-1">${memory.title}</div>
              <div class="text-sm mb-2">${memory.description}</div>
              <div class="text-xs text-gray-500">${new Date(memory.timestamp).toLocaleString()}</div>
              <div class="mt-2 text-xs inline-block px-2 py-1 rounded-full bg-blue-100 text-blue-800">
                ${memory.category}
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

        bounds.extend([memory.location.lat, memory.location.lng]);
      }
    });

    // Fit bounds if we have markers
    if (bounds.isValid()) {
      mapRef.current.fitBounds(bounds, { padding: [50, 50] });
    }

    // Add map controls
    if (!mapRef.current.zoomControl) {
      L.control.zoom({ position: 'bottomright' }).addTo(mapRef.current);
    }

    // Cleanup function
    return () => {
      // No need to clean up here as we handle it at the beginning of the effect
    };
  }, [activeTab, memoriesWithLocation]);

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Memory</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Search Bar */}
        <div className="relative w-full max-w-2xl mx-auto">
          <div className="flex">
            <div className="relative flex-grow">
              <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
                <Search className="h-4 w-4 text-muted-foreground" />
              </div>
              <input
                type="search"
                className="block w-full p-2 pl-10 text-sm border rounded-l-lg bg-background border-input"
                placeholder="Search memories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyPress}
                disabled={loading}
              />
            </div>
            <button
              className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-r-lg border border-primary hover:bg-primary/90 disabled:opacity-50"
              onClick={handleSearch}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              <span className="ml-2">Search</span>
            </button>
          </div>
        </div>

        <Separator className="my-2" />

        {/* Error Display */}
        {error && (
          <Card className="bg-destructive/10 text-destructive">
            <Card.Content className="flex items-start gap-3 p-4">
              <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-medium">Error loading memories</h3>
                <p className="text-sm">{error}</p>
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

        {/* Tabs */}
        {!loading && !error && (
          <Tabs defaultValue="map" className="w-full" onValueChange={setActiveTab} value={activeTab}>
            <Tabs.List className="grid grid-cols-4 w-full max-w-2xl mx-auto">
              <Tabs.Trigger value="map">Map</Tabs.Trigger>
              <Tabs.Trigger value="list">List</Tabs.Trigger>
              <Tabs.Trigger value="calendar">Calendar</Tabs.Trigger>
              <Tabs.Trigger value="insights">Insights</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="list" className="mt-6">
              <div className="rounded-lg border p-4">
                <h3 className="text-lg font-medium mb-4">Memory Timeline</h3>

                {memories.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">No memories found matching your search.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {memories.map((memory) => (
                      <div
                        key={memory.id}
                        className="flex items-start gap-4 p-4 rounded-lg border hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex-shrink-0 p-2 bg-primary/10 rounded-full">
                          {getMemoryIcon(memory)}
                        </div>
                        <div className="flex-grow min-w-0">
                          <div className="flex justify-between items-start">
                            <h4 className="font-medium truncate">{memory.title}</h4>
                            <div className="flex items-center text-muted-foreground text-sm">
                              <Clock className="h-3 w-3 mr-1" />
                              {new Date(memory.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                          </div>
                          <p className="text-muted-foreground text-sm mt-1">
                            {memory.description || 'No description'}
                          </p>
                          <div className="mt-2">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-primary/10">
                              {memory.category}
                            </span>
                          </div>
                          {memory.category === 'Video' && memory.metadata?.url != null && (
                            <div
                              style={{
                                left: 0,
                                width: '50%',
                                height: 0,
                                position: 'relative',
                                paddingBottom: '28.125%',
                              }}
                              className="mt-2"
                            >
                              {memory.metadata.mimetype === 'text/html' ? (
                                <iframe
                                  src={memory.metadata.url as string}
                                  allowFullScreen={true}
                                  style={{
                                    border: 0,
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    height: '100%',
                                    position: 'absolute',
                                  }}
                                />
                              ) : (
                                <video controls>
                                  <source
                                    src={memory.metadata.url as string}
                                    type={memory.metadata.mimetype as string}
                                  />
                                </video>
                              )}
                            </div>
                          )}
                          {memory.category === 'Image' && memory.metadata?.url != null && (
                            <div className="mt-2">
                              <img
                                src={memory.metadata.url as string}
                                alt={memory.description as string}
                                className="max-w-1/2 object-cover"
                              />
                            </div>
                          )}
                          {memory.category === 'Web Page' && memory.metadata?.url != null && (
                            <Link to={memory.metadata.url} target="_blank">
                              <span>{memory.metadata.url as string}</span>
                            </Link>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Tabs.Content>

            <Tabs.Content value="map" className="mt-6">
              <div className="rounded-lg border p-4">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-medium">Memory Map</h3>
                  <div className="text-sm text-muted-foreground">
                    {memoriesWithLocation.length} location{memoriesWithLocation.length !== 1 ? 's' : ''}
                  </div>
                </div>

                {memoriesWithLocation.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">No memories with location data found.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div
                      ref={mapContainerRef}
                      className="h-[500px] w-full rounded-lg border overflow-hidden shadow-sm"
                    ></div>

                    <div className="mt-6">
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="text-md font-medium">Locations</h4>
                        <button
                          className="text-xs text-primary hover:underline"
                          onClick={() => {
                            if (mapRef.current && memoriesWithLocation.length > 0) {
                              const bounds = L.latLngBounds(
                                memoriesWithLocation
                                  .filter((m) => m.location)
                                  .map((m) => [m.location!.lat, m.location!.lng]),
                              );
                              mapRef.current.fitBounds(bounds, { padding: [50, 50] });
                            }
                          }}
                        >
                          View all
                        </button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {memoriesWithLocation.map((memory) => (
                          <div
                            key={memory.id}
                            className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
                            onClick={() => {
                              if (mapRef.current && memory.location) {
                                mapRef.current.setView([memory.location.lat, memory.location.lng], 16);

                                // Find and open the popup for this marker
                                mapRef.current.eachLayer((layer) => {
                                  if (
                                    layer instanceof L.Marker &&
                                    layer.getLatLng().lat === memory.location!.lat &&
                                    layer.getLatLng().lng === memory.location!.lng
                                  ) {
                                    layer.openPopup();
                                  }
                                });
                              }
                            }}
                          >
                            <div className="flex-shrink-0 p-2 bg-primary/10 rounded-full">
                              <MapPin className="h-4 w-4" />
                            </div>
                            <div className="flex-grow min-w-0">
                              <div className="flex justify-between items-start">
                                <h5 className="font-medium text-sm truncate">{memory.title}</h5>
                                <span className="text-xs text-muted-foreground ml-2">
                                  {new Date(memory.timestamp).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                              </div>
                              <p className="text-muted-foreground text-xs truncate">
                                {memory.location?.name || 'Unknown location'}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Tabs.Content>

            <Tabs.Content value="calendar" className="mt-6">
              <div className="rounded-lg border p-8 text-center">
                <h3 className="text-lg font-medium">Calendar View</h3>
                <p className="text-muted-foreground mt-2">
                  Your memories will be displayed in a calendar format here.
                </p>
              </div>
            </Tabs.Content>

            <Tabs.Content value="insights" className="mt-6">
              <div className="rounded-lg border p-8 text-center">
                <h3 className="text-lg font-medium">Insights</h3>
                <p className="text-muted-foreground mt-2">
                  Analytics and insights about your memories will be displayed here.
                </p>
              </div>
            </Tabs.Content>
          </Tabs>
        )}
      </PageContent>
    </>
  );
}
