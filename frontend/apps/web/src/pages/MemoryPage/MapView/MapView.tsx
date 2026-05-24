import { useMemo } from 'react';

import { Map } from '@/components/Map';

import { useEntityService } from '../../MemoryPage/useEntityService';
import { TimelineView } from '../TimelineView';

type LOCATION_TYPE = { properties: { latitude: number; longitude: number } };

export function DesktopMapView() {
  const [{ data }, { setActiveEntity }] = useEntityService();

  const entitiesWithLocation = useMemo(() => {
    const filteredEntities = data.filter((entity) => {
      if (!('location' in entity)) {
        return false;
      }

      const location = entity.location as LOCATION_TYPE;

      if (!location) {
        return false;
      }

      return (
        location.properties.latitude != null &&
        location.properties.longitude != null &&
        !isNaN(location.properties.latitude) &&
        !isNaN(location.properties.longitude) &&
        !(location.properties.latitude === 0 && location.properties.longitude === 0)
      );
    });

    filteredEntities.sort((a, b) => {
      const dateA =
        'time' in a
          ? new Date(a.time as string)
          : 'startTime' in a
            ? new Date(a.startTime as string)
            : new Date();
      const dateB =
        'time' in b
          ? new Date(b.time as string)
          : 'startTime' in b
            ? new Date(b.startTime as string)
            : new Date();
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
        return 0;
      }

      return dateA.getTime() - dateB.getTime();
    });

    return filteredEntities;
  }, [data]);

  return (
    // TODO: This default leads to some map jittering. It's OK for now, but let's think about tracking the user's last location and use that for the default center.
    <Map center={[37.7749, -122.4194]}>
      <Map.Controls position="bottom-right" />
      <Map.Panel position="left" className="w-[300px] relative">
        <TimelineView />
        <SoftBlur />
      </Map.Panel>

      <Map.RouteLayer />
      {entitiesWithLocation.map((entity) => {
        return 'location' in entity ? (
          <Map.Marker
            key={entity.id}
            position={[
              (entity.location as LOCATION_TYPE).properties.latitude,
              (entity.location as LOCATION_TYPE).properties.longitude,
            ]}
            onClick={() => setActiveEntity(entity)}
          />
        ) : null;
      })}
    </Map>
  );
}

export function MobileMapView() {
  return null;
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
