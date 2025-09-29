/// <reference types="google.maps" />
import { useState, useEffect, useRef } from 'react';

import { Portal, usePageTitle } from '@ci/common';
// Google Maps API types
declare global {
  interface Window {
    google: typeof google;
  }
}
import { Breadcrumb, Tabs, Card, Select } from '@ci/shadcn';
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
} from '@ci/shadcn/icons';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { Link } from 'react-router-dom';

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
  const iconClass = 'h-6 w-6';

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

export default function DesktopMemoryPage() {
  usePageTitle('Memory - Companion Intelligence');
  const [{ authToken }] = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('map');
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Filter states
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [connectionFilter, setConnectionFilter] = useState<string>('all');
  const [showTimeline, setShowTimeline] = useState<boolean>(false);

  // Gallery states
  const [galleryFiles, setGalleryFiles] = useState<FileMeta[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);

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
    {
      id: 'demo-3',
      type: 'event',
      title: 'Concert',
      description: 'LA Philharmonic performance',
      timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Entertainment',
      location: {
        id: 'loc-3',
        name: 'Walt Disney Concert Hall',
        lat: 34.0554,
        lng: -118.2499,
        address: '111 S Grand Ave, Los Angeles, CA',
      },
      tags: ['music', 'classical'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    {
      id: 'demo-4',
      type: 'thing',
      title: 'Art Book',
      description: 'Contemporary art photography book',
      timestamp: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Content',
      location: {
        id: 'loc-4',
        name: 'The Broad Museum',
        lat: 34.0544,
        lng: -118.2501,
        address: '221 S Grand Ave, Los Angeles, CA',
      },
      tags: ['art', 'photography'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    // Hollywood
    {
      id: 'demo-5',
      type: 'event',
      title: 'Movie Premiere',
      description: 'Red carpet event for new film',
      timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Entertainment',
      location: {
        id: 'loc-5',
        name: 'TCL Chinese Theatre',
        lat: 34.102,
        lng: -118.3398,
        address: '6925 Hollywood Blvd, Hollywood, CA',
      },
      tags: ['movies', 'premiere'],
      userId: 'demo-user',
      connectionId: 'apple',
      connectionName: 'Apple',
    },
    {
      id: 'demo-6',
      type: 'person',
      title: 'Alex Chen',
      description: 'Film Producer at Warner Bros - Best friend since high school',
      timestamp: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Friend',
      location: {
        id: 'loc-6',
        name: 'Hollywood Bowl',
        lat: 34.1122,
        lng: -118.3394,
        address: '2301 N Highland Ave, Hollywood, CA',
      },
      tags: ['film', 'entertainment', 'friend'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    {
      id: 'demo-7',
      type: 'event',
      title: 'Concert',
      description: 'Coldplay concert at Hollywood Bowl',
      timestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Entertainment',
      location: {
        id: 'loc-7',
        name: 'Hollywood Bowl',
        lat: 34.1122,
        lng: -118.3394,
        address: '2301 N Highland Ave, Hollywood, CA',
      },
      tags: ['music', 'concert'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    {
      id: 'demo-8',
      type: 'thing',
      title: 'Vintage Camera',
      description: 'Leica M6 film camera',
      timestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Electronics',
      location: {
        id: 'loc-8',
        name: "Samy's Camera",
        lat: 34.1016,
        lng: -118.3267,
        address: '431 S Fairfax Ave, Los Angeles, CA',
      },
      tags: ['photography', 'vintage'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    // West Hollywood
    {
      id: 'demo-9',
      type: 'event',
      title: 'Art Gallery Opening',
      description: 'Contemporary art exhibition opening',
      timestamp: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Art',
      location: {
        id: 'loc-9',
        name: 'Gagosian Gallery',
        lat: 34.09,
        lng: -118.3617,
        address: '456 N Camden Dr, Beverly Hills, CA',
      },
      tags: ['art', 'gallery'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    {
      id: 'demo-10',
      type: 'person',
      title: 'Sarah Johnson',
      description: 'Art Curator at LACMA',
      timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Professional Contact',
      location: {
        id: 'loc-10',
        name: 'Los Angeles County Museum of Art',
        lat: 34.0642,
        lng: -118.3591,
        address: '5905 Wilshire Blvd, Los Angeles, CA',
      },
      tags: ['art', 'curator'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    {
      id: 'demo-11',
      type: 'event',
      title: 'Fitness Class',
      description: 'Pilates session at Equinox',
      timestamp: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Fitness',
      location: {
        id: 'loc-11',
        name: 'Equinox West Hollywood',
        lat: 34.09,
        lng: -118.3617,
        address: '8590 Sunset Blvd, West Hollywood, CA',
      },
      tags: ['fitness', 'pilates'],
      userId: 'demo-user',
      connectionId: 'apple',
      connectionName: 'Apple',
    },
    // Santa Monica
    {
      id: 'demo-12',
      type: 'event',
      title: 'Beach Volleyball',
      description: 'Morning beach volleyball game',
      timestamp: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Recreation',
      location: {
        id: 'loc-12',
        name: 'Santa Monica Beach',
        lat: 34.0195,
        lng: -118.4912,
        address: 'Santa Monica Beach, Santa Monica, CA',
      },
      tags: ['beach', 'volleyball'],
      userId: 'demo-user',
      connectionId: 'apple',
      connectionName: 'Apple',
    },
    {
      id: 'demo-13',
      type: 'person',
      title: 'David Kim',
      description: 'Tech Entrepreneur',
      timestamp: new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Professional Contact',
      location: {
        id: 'loc-13',
        name: 'Santa Monica Pier',
        lat: 34.0089,
        lng: -118.4973,
        address: '200 Santa Monica Pier, Santa Monica, CA',
      },
      tags: ['tech', 'startup'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    {
      id: 'demo-14',
      type: 'thing',
      title: 'Surfboard',
      description: 'Custom longboard surfboard',
      timestamp: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Sports Equipment',
      location: {
        id: 'loc-14',
        name: 'Zuma Beach',
        lat: 34.0259,
        lng: -118.7798,
        address: 'Zuma Beach, Malibu, CA',
      },
      tags: ['surfing', 'beach'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    // Venice Beach
    {
      id: 'demo-15',
      type: 'event',
      title: 'Skateboarding Session',
      description: 'Skateboarding at Venice Skate Park',
      timestamp: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Recreation',
      location: {
        id: 'loc-15',
        name: 'Venice Skate Park',
        lat: 33.985,
        lng: -118.4695,
        address: '1500 Ocean Front Walk, Venice, CA',
      },
      tags: ['skateboarding', 'outdoor'],
      userId: 'demo-user',
      connectionId: 'apple',
      connectionName: 'Apple',
    },
    {
      id: 'demo-16',
      type: 'person',
      title: 'Mike Rodriguez',
      description: 'Professional Skateboarder',
      timestamp: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Professional Contact',
      location: {
        id: 'loc-16',
        name: 'Venice Beach Boardwalk',
        lat: 33.985,
        lng: -118.4695,
        address: 'Venice Beach Boardwalk, Venice, CA',
      },
      tags: ['skateboarding', 'sports'],
      userId: 'demo-user',
      connectionId: 'apple',
      connectionName: 'Apple',
    },
    {
      id: 'demo-17',
      type: 'event',
      title: 'Street Art Tour',
      description: 'Guided tour of Venice street art',
      timestamp: new Date(Date.now() - 17 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Tourism',
      location: {
        id: 'loc-17',
        name: 'Venice Beach',
        lat: 33.985,
        lng: -118.4695,
        address: 'Venice Beach, Venice, CA',
      },
      tags: ['art', 'street art'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    // Beverly Hills
    {
      id: 'demo-18',
      type: 'event',
      title: 'Luxury Shopping',
      description: 'Shopping at Rodeo Drive',
      timestamp: new Date(Date.now() - 18 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Shopping',
      location: {
        id: 'loc-18',
        name: 'Rodeo Drive',
        lat: 34.0736,
        lng: -118.4004,
        address: 'Rodeo Drive, Beverly Hills, CA',
      },
      tags: ['shopping', 'luxury'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    {
      id: 'demo-19',
      type: 'person',
      title: 'Jennifer Smith',
      description: 'Fashion Designer - Wife',
      timestamp: new Date(Date.now() - 19 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Family',
      location: {
        id: 'loc-19',
        name: 'Beverly Center',
        lat: 34.0736,
        lng: -118.4004,
        address: '8500 Beverly Blvd, Los Angeles, CA',
      },
      tags: ['fashion', 'design', 'family', 'sister'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    {
      id: 'demo-19b',
      type: 'person',
      title: 'Michael Smith',
      description: 'Software Engineer - Brother',
      timestamp: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Family',
      location: {
        id: 'loc-19b',
        name: 'Silicon Beach',
        lat: 34.0195,
        lng: -118.4912,
        address: 'Santa Monica, CA',
      },
      tags: ['tech', 'software', 'family', 'brother'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    {
      id: 'demo-20',
      type: 'thing',
      title: 'Designer Handbag',
      description: 'Limited edition designer handbag',
      timestamp: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Fashion',
      location: {
        id: 'loc-20',
        name: 'Rodeo Drive',
        lat: 34.0736,
        lng: -118.4004,
        address: 'Rodeo Drive, Beverly Hills, CA',
      },
      tags: ['fashion', 'luxury'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    // Griffith Park (LA)
    {
      id: 'demo-21',
      type: 'event',
      title: 'Hiking',
      description: 'Hiking in Griffith Park',
      timestamp: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Recreation',
      location: {
        id: 'loc-21',
        name: 'Griffith Observatory',
        lat: 34.1184,
        lng: -118.3004,
        address: '2800 E Observatory Rd, Los Angeles, CA',
      },
      tags: ['hiking', 'nature'],
      userId: 'demo-user',
      connectionId: 'apple',
      connectionName: 'Apple',
    },
    {
      id: 'demo-22',
      type: 'person',
      title: 'Dr. Sarah Martinez',
      description: 'Astronomer at Griffith Observatory',
      timestamp: new Date(Date.now() - 23 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Professional Contact',
      location: {
        id: 'loc-22',
        name: 'Griffith Observatory',
        lat: 34.1184,
        lng: -118.3004,
        address: '2800 E Observatory Rd, Los Angeles, CA',
      },
      tags: ['astronomy', 'science'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    {
      id: 'demo-23',
      type: 'thing',
      title: 'Telescope',
      description: 'Professional astronomy telescope',
      timestamp: new Date(Date.now() - 24 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Electronics',
      location: {
        id: 'loc-23',
        name: 'Griffith Observatory',
        lat: 34.1184,
        lng: -118.3004,
        address: '2800 E Observatory Rd, Los Angeles, CA',
      },
      tags: ['astronomy', 'equipment'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    // Koreatown
    {
      id: 'demo-24',
      type: 'event',
      title: 'Karaoke Night',
      description: 'Karaoke with friends in Koreatown',
      timestamp: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Entertainment',
      location: {
        id: 'loc-24',
        name: 'Koreatown',
        lat: 34.0579,
        lng: -118.3006,
        address: 'Koreatown, Los Angeles, CA',
      },
      tags: ['karaoke', 'social'],
      userId: 'demo-user',
      connectionId: 'apple',
      connectionName: 'Apple',
    },
    {
      id: 'demo-25',
      type: 'person',
      title: 'James Kim',
      description: 'Restaurant Owner in Koreatown',
      timestamp: new Date(Date.now() - 26 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Professional Contact',
      location: {
        id: 'loc-25',
        name: 'Koreatown',
        lat: 34.0579,
        lng: -118.3006,
        address: 'Koreatown, Los Angeles, CA',
      },
      tags: ['restaurant', 'business'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    // Echo Park
    {
      id: 'demo-26',
      type: 'event',
      title: 'Lake Walk',
      description: 'Evening walk around Echo Park Lake',
      timestamp: new Date(Date.now() - 27 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Recreation',
      location: {
        id: 'loc-26',
        name: 'Echo Park Lake',
        lat: 34.0781,
        lng: -118.2606,
        address: 'Echo Park Lake, Los Angeles, CA',
      },
      tags: ['walking', 'nature'],
      userId: 'demo-user',
      connectionId: 'apple',
      connectionName: 'Apple',
    },
    {
      id: 'demo-27',
      type: 'person',
      title: 'Maya Patel',
      description: 'Artist and Community Organizer',
      timestamp: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Professional Contact',
      location: {
        id: 'loc-27',
        name: 'Echo Park',
        lat: 34.0781,
        lng: -118.2606,
        address: 'Echo Park, Los Angeles, CA',
      },
      tags: ['art', 'community'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    // Silver Lake
    {
      id: 'demo-28',
      type: 'event',
      title: 'Coffee Meeting',
      description: 'Coffee with startup founder',
      timestamp: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Work',
      location: {
        id: 'loc-28',
        name: 'Silver Lake',
        lat: 34.0867,
        lng: -118.2708,
        address: 'Silver Lake, Los Angeles, CA',
      },
      tags: ['coffee', 'startup'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    {
      id: 'demo-29',
      type: 'person',
      title: 'Alex Rivera',
      description: 'Tech Startup Founder',
      timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Professional Contact',
      location: {
        id: 'loc-29',
        name: 'Silver Lake',
        lat: 34.0867,
        lng: -118.2708,
        address: 'Silver Lake, Los Angeles, CA',
      },
      tags: ['startup', 'tech'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    // Arts District
    {
      id: 'demo-30',
      type: 'event',
      title: 'Art Gallery Opening',
      description: 'Contemporary art exhibition opening',
      timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Art',
      location: {
        id: 'loc-30',
        name: 'Arts District',
        lat: 34.0444,
        lng: -118.2342,
        address: 'Arts District, Los Angeles, CA',
      },
      tags: ['art', 'gallery'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
    {
      id: 'demo-31',
      type: 'person',
      title: 'Sophie Chen',
      description: 'Gallery Curator',
      timestamp: new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Professional Contact',
      location: {
        id: 'loc-31',
        name: 'Arts District',
        lat: 34.0444,
        lng: -118.2342,
        address: 'Arts District, Los Angeles, CA',
      },
      tags: ['art', 'curator'],
      userId: 'demo-user',
      connectionId: 'microsoft',
      connectionName: 'Microsoft',
    },
    {
      id: 'demo-32',
      type: 'thing',
      title: 'Art Installation',
      description: 'Interactive digital art piece',
      timestamp: new Date(Date.now() - 33 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'Art',
      location: {
        id: 'loc-32',
        name: 'Arts District',
        lat: 34.0444,
        lng: -118.2342,
        address: 'Arts District, Los Angeles, CA',
      },
      tags: ['digital art', 'interactive'],
      userId: 'demo-user',
      connectionId: 'google',
      connectionName: 'Google',
    },
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
                defaultValue="map"
                className="flex-shrink-0"
                onValueChange={setActiveTab}
                value={activeTab}
              >
                <Tabs.List className="grid grid-cols-3 w-48">
                  <Tabs.Trigger value="map" className="text-sm">
                    Map
                  </Tabs.Trigger>
                  <Tabs.Trigger value="list" className="text-sm">
                    List
                  </Tabs.Trigger>
                  <Tabs.Trigger value="gallery" className="text-sm">
                    Gallery
                  </Tabs.Trigger>
                </Tabs.List>
              </Tabs>
            </div>
          )}
        </div>

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
                          <div className="mt-2">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-sm font-medium bg-primary/10">
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
                          {memory.category === 'Audio' && memory.metadata?.url != null && (
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
                                <audio controls>
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
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-1 h-[calc(100vh-140px)] -mx-6 -mb-6">
                  {/* Locations List - Left Column */}
                  <div className="lg:col-span-1 flex flex-col overflow-hidden pl-4 pr-2 ">
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
                        <p className="text-muted-foreground">No locations found.</p>
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
                                  {new Date(memory.timestamp).toLocaleDateString()}
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
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
                                className="w-full h-48 object-cover rounded mb-2"
                                loading="lazy"
                              />
                              <div className="text-sm font-medium text-center">{file.name}</div>
                              <div className="text-sm text-gray-400">
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
                                className="w-full h-48 object-cover rounded mb-2 bg-black"
                                preload="metadata"
                              />
                              <div className="text-sm font-medium text-center">{file.name}</div>
                              <div className="text-sm text-gray-400">
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
