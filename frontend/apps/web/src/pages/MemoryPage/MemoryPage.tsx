import { useState, useEffect, useRef } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Separator, Tabs } from '@ci/shadcn';
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
} from '@ci/shadcn/icons';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Add custom styles for Leaflet
import './memory-map.css';

// Sample memory data
interface MemoryItem {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  category: string;
  icon: React.ReactNode;
  location?: {
    lat: number;
    lng: number;
    name?: string;
  };
}

const sampleMemories: MemoryItem[] = [
  {
    id: 'mem-1',
    title: 'Morning Coffee',
    description: 'Had a cappuccino at Blue Bottle Coffee while reading the news',
    timestamp: '2025-05-21T07:30:00Z',
    category: 'Food & Drink',
    icon: <Coffee className="h-5 w-5" />,
    location: {
      lat: 37.7749,
      lng: -122.4194,
      name: 'Blue Bottle Coffee',
    },
  },
  {
    id: 'mem-2',
    title: 'Team Meeting',
    description: 'Weekly sync with the product team about the new feature launch',
    timestamp: '2025-05-21T10:00:00Z',
    category: 'Work',
    icon: <Laptop className="h-5 w-5" />,
  },
  {
    id: 'mem-3',
    title: 'Lunch with Sarah',
    description: 'Met Sarah at the Italian restaurant to catch up about her new job',
    timestamp: '2025-05-21T12:30:00Z',
    category: 'Social',
    icon: <Utensils className="h-5 w-5" />,
    location: {
      lat: 37.7833,
      lng: -122.4167,
      name: 'Italian Restaurant',
    },
  },
  {
    id: 'mem-4',
    title: 'Gym Session',
    description: '45 minutes of strength training and 20 minutes of cardio',
    timestamp: '2025-05-21T17:00:00Z',
    category: 'Fitness',
    icon: <Dumbbell className="h-5 w-5" />,
    location: {
      lat: 37.7694,
      lng: -122.4862,
      name: 'Fitness Center',
    },
  },
  {
    id: 'mem-5',
    title: 'Grocery Shopping',
    description: 'Picked up ingredients for dinner and restocked on essentials',
    timestamp: '2025-05-21T18:30:00Z',
    category: 'Errands',
    icon: <ShoppingCart className="h-5 w-5" />,
    location: {
      lat: 37.7583,
      lng: -122.4294,
      name: 'Whole Foods Market',
    },
  },
  {
    id: 'mem-6',
    title: 'Cooking Dinner',
    description: 'Made pasta primavera with fresh vegetables from the farmers market',
    timestamp: '2025-05-21T19:30:00Z',
    category: 'Food & Drink',
    icon: <Utensils className="h-5 w-5" />,
  },
  {
    id: 'mem-7',
    title: 'Reading Session',
    description: "Read three chapters of 'The Psychology of Money' before bed",
    timestamp: '2025-05-21T21:00:00Z',
    category: 'Learning',
    icon: <BookOpen className="h-5 w-5" />,
  },
  {
    id: 'mem-8',
    title: 'Call with Mom',
    description: 'Caught up with mom about her garden and upcoming visit',
    timestamp: '2025-05-21T20:00:00Z',
    category: 'Family',
    icon: <User className="h-5 w-5" />,
  },
  {
    id: 'mem-9',
    title: 'Drive to Work',
    description: 'Commuted to the office while listening to the Daily podcast',
    timestamp: '2025-05-21T08:30:00Z',
    category: 'Transportation',
    icon: <Car className="h-5 w-5" />,
    location: {
      lat: 37.79,
      lng: -122.4,
      name: 'Office Building',
    },
  },
  {
    id: 'mem-10',
    title: 'Evening Show',
    description: 'Watched two episodes of the new sci-fi series on Netflix',
    timestamp: '2025-05-21T22:00:00Z',
    category: 'Entertainment',
    icon: <Tv className="h-5 w-5" />,
  },
];

export function MemoryPage() {
  usePageTitle('Memory - Companion Intelligence');

  const [searchQuery, setSearchQuery] = useState('');
  const [memories] = useState<MemoryItem[]>(sampleMemories);
  const [activeTab, setActiveTab] = useState('map');
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Filter memories based on search query
  const filteredMemories =
    searchQuery.trim() === ''
      ? memories
      : memories.filter(
          (memory) =>
            memory.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            memory.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
            memory.category.toLowerCase().includes(searchQuery.toLowerCase()),
        );

  // Get memories with location data for the map
  const memoriesWithLocation = filteredMemories.filter((memory) => memory.location);

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

      <div className="w-full flex flex-col gap-6">
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
                onKeyDown={(e) => e.key === 'Enter' && console.log('Searching for:', searchQuery)}
              />
            </div>
            <button
              className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-r-lg border border-primary hover:bg-primary/90"
              onClick={() => console.log('Searching for:', searchQuery)}
            >
              Search
            </button>
          </div>
        </div>

        <Separator className="my-2" />

        {/* Tabs */}
        <Tabs defaultValue="map" className="w-full" onValueChange={setActiveTab} value={activeTab}>
          <Tabs.List className="grid grid-cols-5 w-full max-w-2xl mx-auto">
            <Tabs.Trigger value="map">Map</Tabs.Trigger>
            <Tabs.Trigger value="list">List</Tabs.Trigger>
            <Tabs.Trigger value="feed">Feed</Tabs.Trigger>
            <Tabs.Trigger value="calendar">Calendar</Tabs.Trigger>
            <Tabs.Trigger value="insights">Insights</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="list" className="mt-6">
            <div className="rounded-lg border p-4">
              <h3 className="text-lg font-medium mb-4">Today's Activities</h3>

              {filteredMemories.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No memories found matching your search.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredMemories.map((memory) => (
                    <div
                      key={memory.id}
                      className="flex items-start gap-4 p-4 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex-shrink-0 p-2 bg-primary/10 rounded-full">{memory.icon}</div>
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
                        <p className="text-muted-foreground text-sm mt-1">{memory.description}</p>
                        <div className="mt-2">
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-primary/10">
                            {memory.category}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Tabs.Content>

          <Tabs.Content value="feed" className="mt-6">
            <div className="rounded-lg border p-8 text-center">
              <h3 className="text-lg font-medium">Feed View</h3>
              <p className="text-muted-foreground mt-2">
                Your memories will be displayed in a feed format here.
              </p>
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
      </div>
    </>
  );
}
