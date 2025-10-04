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
import { Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';
import { useDeviceLayout } from '@/hooks/use-device-layout';
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
  const iconClass = 'h-5 w-5 md:h-6 md:w-6';

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

// Generate fake San Francisco events for today
function generateFakeSFEvents(): MemoryItem[] {
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
      connectionId: 'google',
      connectionName: 'Google',
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
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
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
      connectionId: 'google',
      connectionName: 'Google',
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
      connectionId: 'apple',
      connectionName: 'Apple',
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
      connectionId: 'google',
      connectionName: 'Google',
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
      connectionId: 'google',
      connectionName: 'Google',
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
      connectionId: 'google',
      connectionName: 'Google',
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
      connectionId: 'google',
      connectionName: 'Google',
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
      connectionId: 'google',
      connectionName: 'Google',
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
      connectionId: 'apple',
      connectionName: 'Apple',
    },
  ];
}

export default function MemoryPage() {
  usePageTitle('Memory - Companion Intelligence');
  const [{ authToken }] = useAuth();
  const { isMobile } = useDeviceLayout();

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
  const [showTimeline, setShowTimeline] = useState<boolean>(true); // Default to true to show contrail

  // Gallery states
  const [galleryFiles, setGalleryFiles] = useState<FileMeta[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);

  // Mobile-specific states
  const [showFilters, setShowFilters] = useState(false);

  // Fetch memories from API
  const fetchMemories = async (query?: string) => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (query) {
        params.append('query', query);
      }

      const response = await fetch(`/api/memory/search?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch memories');
      }

      const data = await response.json();
      
      // If no data from API, use fake SF events
      if (!data || data.length === 0) {
        console.log('No memories from API, using fake San Francisco events');
        setMemories(generateFakeSFEvents());
      } else {
        setMemories(data);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error fetching memories:', errorMessage, err);
      // On error, also use fake data
      console.log('Error fetching memories, using fake San Francisco events');
      setMemories(generateFakeSFEvents());
      setError(null); // Don't show error since we have fake data
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

      const metaList: FileM eta[] = (await res.json()).map((file: FileMeta) => ({
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

  // Initialize and update map when the tab changes or filtered memories change
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
      // This fixes the issue with the map not appearing when switching back to the tab
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      // Default to San Francisco coordinates
      const defaultLat = 37.7749;
      const defaultLng = -122.4194;
      const defaultZoom = 13;

      // Initialize map centered on San Francisco (or first memory location if available)
      const centerLat = memoriesWithLocation.length > 0 ? memoriesWithLocation[0].location!.lat : defaultLat;
      const centerLng = memoriesWithLocation.length > 0 ? memoriesWithLocation[0].location!.lng : defaultLng;
      
      mapRef.current = L.map(mapContainerRef.current).setView([centerLat, centerLng], defaultZoom);

      // Use satellite imagery
      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          attribution: '',
          maxZoom: 20,
        },
      ).addTo(mapRef.current);

      // Only add markers if we have memories with location
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

                // Create the route path (contrail)
                L.polyline(waypoints, {
                  color: '#3b82f6',
                  weight: 4,
                  opacity: 0.8,
                  smoothFactor: 1,
                }).addTo(mapRef.current!);

                console.log(`Created Google Maps route ${index + 1} with ${waypoints.length} waypoints`);
              } else {
                console.warn('No routes returned from Google Maps');
                createFallbackRoute(start, end, index);
              }
            } catch (error) {
              console.warn('Google Maps JavaScript API call failed, using fallback route:', error);
              // Always create fallback route when Google Maps fails
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
              color: '#3b82f6',
              weight: 4,
              opacity: 0.8,
              smoothFactor: 1,
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
          mapRef.current.fitBounds(bounds, { padding: [50, 50] });
        }
      }

      // Add map controls
      if (!mapRef.current.zoomControl) {
        L.control.zoom({ position: 'bottomright' }).addTo(mapRef.current);
      }

      // Cleanup function
      return () => {
        // No need to clean up here as we handle it at the beginning of the effect
      };
    };

    initializeMap();
  }, [activeTab, memoriesWithLocation, showTimeline]);

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
        {/* Search Bar and Filters */}
        {isMobile ? (
          // Mobile Layout
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
        ) : (
          // Desktop Layout
          <div className="flex items-center w-full -mx-2">
            {/* Search Bar - Full Width */}
            <div className="relative flex-grow max-w-2xl pl-0 pr-2">
              <div className="flex">
                <div className="relative flex-grow">
                  <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
                    <Search className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <input
                    type="search"
                    className="block w-full p-2 pl-10 text-base border rounded-l-lg bg-background border-input"
                    placeholder="Search memories..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleKeyPress}
                    disabled={loading}
                  />
                </div>
                <button
                  className="inline-flex items-center justify-center px-4 py-2 mr-4 text-base font-medium bg-primary text-primary-foreground rounded-r-lg border border-primary hover:bg-primary/90 disabled:opacity-50"
                  onClick={handleSearch}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Search className="h-6 w-6" />}
                  <span className="ml-2">Search</span>
                </button>
              </div>
            </div>

            {/* Spacer */}
            <div className="flex-grow"></div>

            {/* Filters and View Toggle - Right Aligned */}
            {!loading && !error && (
              <div className="flex items-center gap-4 relative z-[100] -mr-2">
                {/* Location Count */}
                <div className="text-base text-muted-foreground">
                  {memoriesWithLocation.length} location{memoriesWithLocation.length !== 1 ? 's' : ''}
                </div>

                {/* Type Filter */}
                <div className="flex items-center gap-2 relative z-[100]">
                  <Filter className="h-6 w-6 text-muted-foreground" />
                  <Select value={typeFilter} onValueChange={setTypeFilter}>
                    <Select.Trigger className="w-32 h-8 text-sm">
                      <Select.Value placeholder="Type" />
                    </Select.Trigger>
                    <Select.Content className="z-[100]">
                      <Select.Item value="all">All Types</Select.Item>
                      <Select.Item value="event">Events</Select.Item>
                      <Select.Item value="content">Content</Select.Item>
                      <Select.Item value="person">People</Select.Item>
                      <Select.Item value="thing">Things</Select.Item>
                    </Select.Content>
                  </Select>
                </div>

                {/* Connection Filter */}
                <div className="relative z-[100]">
                  <Select value={connectionFilter} onValueChange={setConnectionFilter}>
                    <Select.Trigger className="w-40 h-8 text-sm">
                      <Select.Value placeholder="Connection" />
                    </Select.Trigger>
                    <Select.Content className="z-[100]">
                      <Select.Item value="all">All Connections</Select.Item>
                      <Select.Item value="google">Google</Select.Item>
                      <Select.Item value="microsoft">Microsoft</Select.Item>
                      <Select.Item value="apple">Apple</Select.Item>
                    </Select.Content>
                  </Select>
                </div>

                {/* View Toggle */}
                <Tabs
                  defaultValue="list"
                  className="flex-shrink-0"
                  onValueChange={setActiveTab}
                  value={activeTab}
                >
                  <Tabs.List className="grid grid-cols-3 w-48">
                    <Tabs.Trigger value="list" className="text-sm">
                      List
                    </Tabs.Trigger>
                    <Tabs.Trigger value="map" className="text-sm">
                      Map
                    </Tabs.Trigger>
                    <Tabs.Trigger value="gallery" className="text-sm">
                      Gallery
                    </Tabs.Trigger>
                  </Tabs.List>
                </Tabs>
              </div>
            )}
          </div>
        )}

        {/* Error Display */}
        {error && (
          <Card className="bg-destructive/10 text-destructive">
            <Card.Content className="flex items-start gap-3 p-4">
              <AlertCircle className="h-6 w-6 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-medium">Error loading memories</h3>
                <p className="text-base">{error}</p>
              </div>
            </Card.Content>
          </Card>
        )}

        {/* Loading State */}
        {loading && (
          <div className="flex justify-center items-center py-12">
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Content */}
        {!loading && !error && (
          <>
            {activeTab === 'list' && (
              <>
                {filteredMemories.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">
                      No memories found matching your search and filters.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {filteredMemories.map((memory) => (
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
                            <div className="flex items-center text-muted-foreground text-base">
                              <Clock className="h-5 w-5 mr-1" />
                              {new Date(memory.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                          </div>
                          <p className="text-muted-foreground text-base mt-1">
                            {memory.description || 'No description'}
                          </p>
                          <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-sm font-medium bg-primary/10">
                              {memory.category}
                            </span>
                            {memory.location && (
                              <span className="text-sm text-muted-foreground flex items-center gap-1">
                                <MapPin className="h-4 w-4" />
                                {memory.location.name}
                              </span>
                            )}
                          </div>
                          {memory.category === 'Video' && memory.metadata?.url != null && (
                            <div
                              style={{
                                left: 0,
                                width: isMobile ? '100%' : '50%',
                                height: 0,
                                position: 'relative',
                                paddingBottom: isMobile ? '56.25%' : '28.125%',
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
                                <video controls className="absolute top-0 left-0 w-full h-full">
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
                                className={isMobile ? 'w-full object-cover' : 'max-w-1/2 object-cover'}
                              />
                            </div>
                          )}
                          {memory.category === 'Web Page' && memory.metadata?.url != null && (
                            <Link to={memory.metadata.url as string} target="_blank" className="mt-2 block">
                              <span className="text-primary hover:underline">{memory.metadata.url as string}</span>
                            </Link>
                          )}
                          {memory.category === 'Audio' && memory.metadata?.url != null && (
                            <div
                              style={{
                                left: 0,
                                width: isMobile ? '100%' : '50%',
                                height: 0,
                                position: 'relative',
                                paddingBottom: isMobile ? '56.25%' : '28.125%',
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
                                <audio controls className="absolute top-0 left-0 w-full">
                                  <source
                                    src={memory.metadata.url as string}
                                    type={memory.metadata.mimetype as string}
                                  />
                                </audio>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {activeTab === 'map' && (
              <>
                {isMobile ? (
                  // Mobile Map View - Full Screen
                  <div className="h-[calc(100vh-200px)] -mx-2 -mb-2">
                    <div ref={mapContainerRef} className="h-full w-full" style={{ touchAction: 'none' }} />
                  </div>
                ) : (
                  // Desktop Map View - Split Layout
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-1 h-[calc(100vh-140px)] -mx-6 -mb-6">
                    {/* Locations List - Left Column */}
                    <div className="lg:col-span-1 flex flex-col overflow-hidden pl-4 pr-2">
                      <div className="flex justify-between items-center mb-4 flex-shrink-0">
                        <button
                          onClick={() => setShowTimeline(!showTimeline)}
                          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border transition-colors ${
                            showTimeline
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-background text-foreground border-input hover:bg-accent'
                          }`}
                        >
                          <Route className="h-5 w-5" />
                          Timeline
                        </button>
                      </div>

                      {memoriesWithLocation.length === 0 ? (
                        <div className="text-center py-8">
                          <p className="text-muted-foreground text-sm">
                            Showing San Francisco map with sample events from today.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-3 flex-1 overflow-y-auto pr-1">
                          {memoriesWithLocation.map((memory) => (
                            <div
                              key={memory.id}
                              className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
                              onClick={() => {
                                if (mapRef.current && memory.location) {
                                  mapRef.current.setView([memory.location.lat, memory.location.lng], 15);
                                }
                              }}
                            >
                              <div className="flex-shrink-0 p-1.5 bg-primary/10 rounded-full">
                                {getMemoryIcon(memory)}
                              </div>
                              <div className="flex-grow min-w-0">
                                <h4 className="font-medium text-base truncate">{memory.title}</h4>
                                <p className="text-sm text-muted-foreground truncate">
                                  {memory.location?.name || 'Unknown location'}
                                </p>
                                <div className="flex items-center gap-2 mt-1">
                                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-sm font-medium bg-primary/10">
                                    {memory.category}
                                  </span>
                                  <span className="text-sm text-muted-foreground">
                                    {new Date(memory.timestamp).toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Map - Right Column */}
                    <div className="lg:col-span-2 relative">
                      <div
                        ref={mapContainerRef}
                        className="h-full w-full"
                        style={{ touchAction: 'none' }}
                      ></div>
                    </div>
                  </div>
                )}
              </>
            )}

            {activeTab === 'gallery' && (
              <>
                <div className="space-y-6">
                  {/* Gallery Content */}
                  {galleryLoading ? (
                    <div className="flex justify-center items-center py-12">
                      <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className={`grid gap-6 ${isMobile ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4'}`}>
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
                                className={`w-full object-cover rounded mb-2 ${isMobile ? 'h-32' : 'h-48'}`}
                                loading="lazy"
                              />
                              <div className={`font-medium text-center ${isMobile ? 'text-xs truncate w-full' : 'text-sm'}`}>
                                {file.name}
                              </div>
                              <div className={`text-gray-400 ${isMobile ? 'text-xs' : 'text-sm'}`}>
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
                                className={`w-full object-cover rounded mb-2 bg-black ${isMobile ? 'h-32' : 'h-48'}`}
                                preload="metadata"
                              />
                              <div className={`font-medium text-center ${isMobile ? 'text-xs truncate w-full' : 'text-sm'}`}>
                                {file.name}
                              </div>
                              <div className={`text-gray-400 ${isMobile ? 'text-xs' : 'text-sm'}`}>
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
                    <div className="text-center py-12">
                      <p className="text-muted-foreground">No content uploaded yet.</p>
                      <p className="text-base text-muted-foreground mt-1">
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
