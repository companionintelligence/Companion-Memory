import { useMemo } from 'react';

import { Map } from '@/components/Map';
import { type MarkerVariant } from '@/components/Map/Marker';

import { useEntityService, type EntityItem } from '../../MemoryPage/useEntityService';
import { TimelineView } from '../TimelineView';

// Colour/icon-code each marker by what it represents, like the old LifeScope map.
const MARKER_VARIANT_BY_TYPENAME: Record<string, MarkerVariant> = {
  PlaceType: 'place',
  EventType: 'event',
  PersonType: 'person',
  ContentType: 'content',
  FileType: 'file',
  ConceptType: 'concept',
  BrowserActivityType: 'browser-activity',
  ItemType: 'item',
  NoteType: 'note',
  CommunicationType: 'communication',
  AnswerType: 'answer',
  ThreadType: 'thread',
};

function markerVariant(entity: EntityItem): MarkerVariant {
  return MARKER_VARIANT_BY_TYPENAME[entity.__typename] ?? 'default';
}

type Coordinates = { latitude?: number | null; longitude?: number | null };

function readCoordinates(props: unknown): { lat: number; lng: number } | null {
  if (props == null || typeof props !== 'object') {
    return null;
  }

  const { latitude, longitude } = props as Coordinates;

  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    isNaN(latitude) ||
    isNaN(longitude) ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }

  return { lat: latitude, lng: longitude };
}

/**
 * Resolve a marker position for any entity in the explorer result set.
 * Places carry their coordinates directly in `properties`; events (and other
 * entities) carry them on a resolved `location` PlaceType.
 */
function getEntityCoordinates(entity: EntityItem): { lat: number; lng: number } | null {
  if (entity.__typename === 'PlaceType' && 'properties' in entity) {
    return readCoordinates((entity as { properties?: unknown }).properties);
  }

  if ('location' in entity && entity.location) {
    return readCoordinates((entity.location as { properties?: unknown }).properties);
  }

  return null;
}

function entityTime(entity: EntityItem): number {
  const value =
    'time' in entity ? (entity.time as string) : 'startTime' in entity ? (entity.startTime as string) : null;

  const date = value ? new Date(value) : null;

  return date && !isNaN(date.getTime()) ? date.getTime() : 0;
}

type LocatedEntity = { entity: EntityItem; coords: { lat: number; lng: number } };

function useLocatedEntities() {
  const [{ data }, { setActiveEntity }] = useEntityService();

  const located = useMemo<LocatedEntity[]>(() => {
    return data
      .map((entity) => ({ entity, coords: getEntityCoordinates(entity) }))
      .filter((item): item is LocatedEntity => item.coords != null)
      .sort((a, b) => entityTime(a.entity) - entityTime(b.entity));
  }, [data]);

  return { located, setActiveEntity };
}

function EntityMarkers({
  located,
  onSelect,
}: {
  located: LocatedEntity[];
  onSelect: (entity: EntityItem) => void;
}) {
  return (
    <>
      {located.map(({ entity, coords }) => (
        <Map.Marker
          key={entity.id}
          position={[coords.lat, coords.lng]}
          variant={markerVariant(entity)}
          onClick={() => onSelect(entity)}
        />
      ))}
    </>
  );
}

export function DesktopMapView() {
  const { located, setActiveEntity } = useLocatedEntities();

  return (
    // TODO: This default leads to some map jittering. It's OK for now, but let's think about tracking the user's last location and use that for the default center.
    <Map center={[37.7749, -122.4194]}>
      <Map.Controls position="bottom-right" />
      <Map.Panel position="left" className="w-[300px] relative">
        <TimelineView />
        <SoftBlur />
      </Map.Panel>

      <Map.RouteLayer />
      <EntityMarkers located={located} onSelect={setActiveEntity} />
    </Map>
  );
}

export function MobileMapView() {
  const { located, setActiveEntity } = useLocatedEntities();

  return (
    <Map center={[37.7749, -122.4194]}>
      <Map.Controls position="bottom-right" />
      <Map.RouteLayer />
      <EntityMarkers located={located} onSelect={setActiveEntity} />
    </Map>
  );
}

function SoftBlur({ className = '' }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 backdrop-blur-xl -z-1 ${className}`}
      style={{
        WebkitMaskImage: 'linear-gradient(to right, black 70%, transparent)',
        maskImage: 'linear-gradient(to right, black 70%, transparent)',
      }}
    />
  );
}
