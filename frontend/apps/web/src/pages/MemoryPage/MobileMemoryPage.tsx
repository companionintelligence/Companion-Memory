/// <reference types="google.maps" />
import { useState, useEffect, useRef } from 'react';

import { Portal, usePageTitle } from '@ci/common';
// Google Maps API types
declare global {
  interface Window {
    google: typeof google;
  }
}
import { Breadcrumb, Tabs, Card, Select, Button } from '@ci/shadcn';
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
  Calendar,
  FileText,
  Package,
  Users,
  Phone,
  Loader2,
  AlertCircle,
  Filter,
  Route,
  MapPin,
  List,
  Images,
  X,
} from '@ci/shadcn/icons';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';
import { loadGoogleMaps } from '@/pages/MemoryPage/googleMaps';

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
  connectionId?: string;
  connectionName?: string;
}

// File metadata for gallery
interface FileMeta {
  id: string;
  name: string;
  contentType: string;
  size: string;
  url?: string;
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

export default function MobileMemoryPage() {
  usePageTitle('Memory - Companion Intelligence');
  const [{ authToken }] = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('list');
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Filter states
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [connectionFilter, setConnectionFilter] = useState<string>('all');
  const [showTimeline, setShowTimeline] = useState<boolean>(false);

  // Gallery states
  const [galleryFiles, setGalleryFiles] = useState<FileMeta[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);

  // Mobile-specific states
  const [showFilters, setShowFilters] = useState(false);

  // Demo data focused on Los Angeles city only
  const demoMemories: MemoryItem[] = [
    // Downtown LA
    {
      id: 'demo-1',
      type: 'event',
      title: 'Client Meeting',
      description: 'Product demo for new client',
      timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Work',
      location: {
        id: 'loc-1',
        name: 'WeWork Downtown LA',
        lat: 34.0522,
        lng: -118.2437,
        address: '800 S Figueroa St, Los Angeles, CA',
      },
      tags: ['client', 'business'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    {
      id: 'demo-2',
      type: 'person',
      title: 'Maria Rodriguez',
      description: 'Design Director at Disney - Close friend from college',
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Friend',
      location: {
        id: 'loc-2',
        name: 'Walt Disney Concert Hall',
        lat: 34.0554,
        lng: -118.2499,
        address: '111 S Grand Ave, Los Angeles, CA',
      },
      tags: ['design', 'entertainment', 'friend'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    // Add more demo data as needed...
  ];

  // Fetch memories from API (using demo data for now)
  const fetchMemories = async (query?: string) => {
    try {
      setLoading(true);
      setError(null);

      // Simulate API delay
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Filter demo data based on query
      let filteredData = demoMemories;
      if (query) {
        const searchQuery = query.toLowerCase();
        filteredData = demoMemories.filter(
          (memory) =>
            memory.title.toLowerCase().includes(searchQuery) ||
            memory.description?.toLowerCase().includes(searchQuery) ||
            memory.category.toLowerCase().includes(searchQuery) ||
            memory.tags.some((tag) => tag.toLowerCase().includes(searchQuery)),
        );
      }

      setMemories(filteredData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error fetching memories:', errorMessage, err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  // Fetch files for gallery
  const fetchGalleryFiles = async () => {
    setGalleryLoading(true);
    try {
      const res = await fetch('/api/files', {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!res.ok) {
        throw new Error('Failed to fetch file list');
      }

      const metaList: FileMeta[] = (await res.json()).map((file: FileMeta) => ({
        ...file,
        url: `/static${file.url}`,
      }));

      setGalleryFiles(metaList);
    } catch (err) {
      console.error('Error fetching gallery files:', err);
    } finally {
      setGalleryLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchMemories();
  }, [authToken]);

  // Load gallery files when gallery tab is active
  useEffect(() => {
    if (activeTab === 'gallery') {
      fetchGalleryFiles();
    }
  }, [activeTab, authToken]);

  // Handle search
  const handleSearch = () => {
    fetchMemories(searchQuery);
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  // Apply filters to memories
  const filteredMemories = memories.filter((memory) => {
    // Type filter
    if (typeFilter !== 'all' && memory.type !== typeFilter) {
      return false;
    }

    // Connection filter
    if (connectionFilter !== 'all' && memory.connectionId !== connectionFilter) {
      return false;
    }

    return true;
  });

  // Get memories with location data for the map
  const memoriesWithLocation = filteredMemories.filter((memory) => memory.location);

  // Function to wait for Google Maps to load
  const waitForGoogleMaps = (): Promise<void> => {
    return loadGoogleMaps();
  };

  // Initialize map for mobile
  useEffect(() => {
    const initializeMap = async () => {
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
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      // Initialize map centered on Los Angeles
      mapRef.current = L.map(mapContainerRef.current).setView([34.0522, -118.2437], 12);

      // Use satellite imagery
      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          attribution: '',
          maxZoom: 20,
        },
      ).addTo(mapRef.current);

      // Create custom icon for markers
      const customIcon = L.divIcon({
        className: 'custom-map-marker',
        html: `<div class="w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-md">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
            </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 24],
        popupAnchor: [0, -24],
      });

      // Add markers for memories with location
      const bounds = L.latLngBounds([]);
      const markers: L.Marker[] = [];

      // Sort memories by timestamp for timeline
      const sortedMemories = [...memoriesWithLocation].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      sortedMemories.forEach((memory, index) => {
        if (memory.location) {
          const marker = L.marker([memory.location.lat, memory.location.lng], { icon: customIcon })
            .addTo(mapRef.current!)
            .bindPopup(
              `
            <div class="p-3">
              ${
                memory.category === 'Image' && memory.metadata?.url
                  ? `<div class="mb-3 -mx-3 -mt-3">
                  <img src="${memory.metadata.url}" alt="${memory.title}" class="w-full h-32 object-cover rounded-t-lg" />
                </div>`
                  : ''
              }
              <div class="font-bold text-lg mb-1">${memory.title}</div>
              <div class="text-sm mb-2 text-gray-600">${memory.description || 'No description'}</div>
              <div class="text-xs text-gray-500">${new Date(memory.timestamp).toLocaleString()}</div>
              <div class="mt-2 flex items-center gap-2">
                <span class="text-xs inline-block px-2 py-1 rounded-full bg-blue-100 text-blue-800">
                  ${memory.category}
                </span>
                ${showTimeline ? `<span class="text-xs text-gray-500">#${index + 1}</span>` : ''}
                ${
                  memory.category === 'Video' && memory.metadata?.url
                    ? '<span class="text-xs text-gray-500">📹 Video</span>'
                    : ''
                }
                ${
                  memory.category === 'Audio' && memory.metadata?.url
                    ? '<span class="text-xs text-gray-500">🎵 Audio</span>'
                    : ''
                }
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

      // Add timeline path if enabled
      if (showTimeline && markers.length > 1) {
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
            .addTo(mapRef.current!)
            .bindTooltip(`Step ${index + 1}: ${sortedMemories[index].title}`, {
              permanent: false,
              direction: 'top',
              offset: [0, -10],
            });
        });

        // Create actual road routes using Google Maps JavaScript API
        const createRoadRoute = async (start: L.LatLng, end: L.LatLng, index: number) => {
          try {
            // Wait for Google Maps to load
            await waitForGoogleMaps();

            console.log(`Creating route ${index + 1} using Google Maps JavaScript API...`);

            // Create Google Maps LatLng objects
            const googleStart = new window.google.maps.LatLng(start.lat, start.lng);
            const googleEnd = new window.google.maps.LatLng(end.lat, end.lng);

            // Create DirectionsService
            const directionsService = new window.google.maps.DirectionsService();

            // Request directions
            const request = {
              origin: googleStart,
              destination: googleEnd,
              travelMode: window.google.maps.TravelMode.DRIVING,
              avoidHighways: false,
              avoidTolls: false,
            };

            // Get directions
            const result = await new Promise<google.maps.DirectionsResult>((resolve, reject) => {
              directionsService.route(
                request,
                (result: google.maps.DirectionsResult | null, status: google.maps.DirectionsStatus) => {
                  if (status === window.google.maps.DirectionsStatus.OK && result) {
                    resolve(result);
                  } else {
                    reject(new Error(`Directions request failed: ${status}`));
                  }
                },
              );
            });

            if (result.routes && result.routes.length > 0) {
              const route = result.routes[0];
              const overviewPath = route.overview_path;

              console.log(`Got ${overviewPath.length} waypoints for route ${index + 1} from Google Maps`);

              // Convert Google Maps LatLng to Leaflet LatLng
              const waypoints = overviewPath.map(
                (point: google.maps.LatLng) => new L.LatLng(point.lat(), point.lng()),
              );

              // Create the route path
              L.polyline(waypoints, {
                color: '#3b82f6',
                weight: 5,
                opacity: 0.9,
                dashArray: '20, 10',
              }).addTo(mapRef.current!);

              console.log(`Created Google Maps route ${index + 1} with ${waypoints.length} waypoints`);
            } else {
              console.warn('No routes returned from Google Maps');
              createFallbackRoute(start, end, index);
            }
          } catch (error) {
            console.warn('Google Maps JavaScript API call failed, using fallback route:', error);
            createFallbackRoute(start, end, index);
          }
        };

        // Fallback route creation (straight line with some curves)
        const createFallbackRoute = (start: L.LatLng, end: L.LatLng, index: number) => {
          const distance = start.distanceTo(end);
          const numWaypoints = Math.max(3, Math.min(10, Math.floor(distance / 500)));

          const waypoints: L.LatLng[] = [];

          for (let i = 0; i <= numWaypoints; i++) {
            const ratio = i / numWaypoints;
            const curveIntensity = 0.002;
            const latOffset = Math.sin(ratio * Math.PI) * curveIntensity * (i % 2 === 0 ? 1 : -1);
            const lngOffset = Math.cos(ratio * Math.PI) * curveIntensity * (i % 2 === 0 ? 1 : -1);

            const waypoint = new L.LatLng(
              start.lat + (end.lat - start.lat) * ratio + latOffset,
              start.lng + (end.lng - start.lng) * ratio + lngOffset,
            );

            waypoints.push(waypoint);
          }

          L.polyline(waypoints, {
            color: '#ef4444',
            weight: 3,
            opacity: 0.7,
            dashArray: '10, 5',
          }).addTo(mapRef.current!);

          console.log(`Created fallback route ${index + 1} with ${waypoints.length} waypoints`);
        };

        // Create routes between consecutive points
        for (let i = 0; i < markers.length - 1; i++) {
          const start = markers[i].getLatLng();
          const end = markers[i + 1].getLatLng();
          await createRoadRoute(start, end, i);
        }
      }

      // Fit bounds if we have markers
      if (bounds.isValid()) {
        mapRef.current.fitBounds(bounds, { padding: [20, 20] });
      }

      // Add map controls
      if (!mapRef.current.zoomControl) {
        L.control.zoom({ position: 'bottomright' }).addTo(mapRef.current);
      }
    };

    initializeMap();
  }, [activeTab, memoriesWithLocation, showTimeline]);

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
              className="block w-full p-3 pl-10 text-base border rounded-lg bg-background border-input"
              placeholder="Search memories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyPress}
              disabled={loading}
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
              <Tabs.List className="grid grid-cols-3 w-full">
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
                  <Select value={typeFilter} onValueChange={setTypeFilter}>
                    <Select.Trigger className="w-full h-9 text-sm">
                      <Select.Value placeholder="Type" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="all">All Types</Select.Item>
                      <Select.Item value="event">Events</Select.Item>
                      <Select.Item value="content">Content</Select.Item>
                      <Select.Item value="person">People</Select.Item>
                      <Select.Item value="thing">Things</Select.Item>
                    </Select.Content>
                  </Select>
                </div>

                <div>
                  <label className="text-sm font-medium mb-1 block">Connection</label>
                  <Select value={connectionFilter} onValueChange={setConnectionFilter}>
                    <Select.Trigger className="w-full h-9 text-sm">
                      <Select.Value placeholder="Connection" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="all">All Connections</Select.Item>
                      <Select.Item value="google">Google</Select.Item>
                      <Select.Item value="microsoft">Microsoft</Select.Item>
                      <Select.Item value="apple">Apple</Select.Item>
                    </Select.Content>
                  </Select>
                </div>
              </div>

              {activeTab === 'map' && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {memoriesWithLocation.length} location{memoriesWithLocation.length !== 1 ? 's' : ''}
                  </span>
                  <Button
                    variant={showTimeline ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setShowTimeline(!showTimeline)}
                    className="flex items-center gap-1"
                  >
                    <Route className="h-4 w-4" />
                    Timeline
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <Card className="bg-destructive/10 text-destructive">
            <Card.Content className="flex items-start gap-3 p-3">
              <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-medium text-sm">Error loading memories</h3>
                <p className="text-sm">{error}</p>
              </div>
            </Card.Content>
          </Card>
        )}

        {/* Loading State */}
        {loading && (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Content */}
        {!loading && !error && (
          <>
            {activeTab === 'list' && (
              <>
                {filteredMemories.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground text-sm">
                      No memories found matching your search and filters.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredMemories.map((memory) => (
                      <div
                        key={memory.id}
                        className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex-shrink-0 p-2 bg-primary/10 rounded-full">
                          {getMemoryIcon(memory)}
                        </div>
                        <div className="flex-grow min-w-0">
                          <div className="flex justify-between items-start">
                            <h4 className="font-medium text-sm truncate">{memory.title}</h4>
                            <div className="flex items-center text-muted-foreground text-xs">
                              <Clock className="h-4 w-4 mr-1" />
                              {new Date(memory.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                          </div>
                          <p className="text-muted-foreground text-sm mt-1 line-clamp-2">
                            {memory.description || 'No description'}
                          </p>
                          <div className="mt-2 flex items-center gap-2">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-primary/10">
                              {memory.category}
                            </span>
                            {memory.location && (
                              <span className="text-xs text-muted-foreground flex items-center gap-1">
                                <MapPin className="h-3 w-3" />
                                {memory.location.name}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {activeTab === 'map' && (
              <div className="h-[calc(100vh-140px)] -mx-2 -mb-2">
                <div ref={mapContainerRef} className="h-full w-full" style={{ touchAction: 'none' }} />
              </div>
            )}

            {activeTab === 'gallery' && (
              <>
                <div className="space-y-4">
                  {/* Gallery Content */}
                  {galleryLoading ? (
                    <div className="flex justify-center items-center py-8">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      {galleryFiles.map((file) => {
                        if (file.contentType.startsWith('image/')) {
                          return (
                            <div
                              key={file.id}
                              className="flex flex-col items-center border rounded-lg p-2 bg-gray-50 shadow hover:shadow-md transition-shadow"
                            >
                              <img
                                src={file.url}
                                alt={file.name}
                                className="w-full h-32 object-cover rounded mb-2"
                                loading="lazy"
                              />
                              <div className="text-xs font-medium text-center truncate w-full">
                                {file.name}
                              </div>
                              <div className="text-xs text-gray-400">
                                {(Number(file.size) / 1024).toFixed(1)} KB
                              </div>
                            </div>
                          );
                        }

                        if (file.contentType.startsWith('video/')) {
                          return (
                            <div
                              key={file.id}
                              className="flex flex-col items-center border rounded-lg p-2 bg-gray-50 shadow hover:shadow-md transition-shadow"
                            >
                              <video
                                src={file.url}
                                controls
                                className="w-full h-32 object-cover rounded mb-2 bg-black"
                                preload="metadata"
                              />
                              <div className="text-xs font-medium text-center truncate w-full">
                                {file.name}
                              </div>
                              <div className="text-xs text-gray-400">
                                {(Number(file.size) / 1024 / 1024).toFixed(1)} MB
                              </div>
                            </div>
                          );
                        }

                        return null;
                      })}
                    </div>
                  )}

                  {!galleryLoading && galleryFiles.length === 0 && (
                    <div className="text-center py-8">
                      <p className="text-muted-foreground text-sm">No content uploaded yet.</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Use the + button to add new content.
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </PageContent>
    </>
  );
}
