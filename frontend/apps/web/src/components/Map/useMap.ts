import { useCallback, useEffect, useMemo, useState } from 'react';

import { createHookContext } from '@ci/common';
import L, { type LatLngExpression } from 'leaflet';
import { useMap as useLeafletMap } from 'react-leaflet';

type ReturnType = [
  {
    locations: LatLngExpression[];
    displayRoutes: boolean;
  },
  {
    toggleRoutes: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    centerVisibleMarkers: () => void;
  },
];

interface MapOptions {
  /** Let the generic map choose a marker centroid before a specialized view applies its own camera. */
  autoCenterMarkers?: boolean;
}

function useMap({ autoCenterMarkers = true }: MapOptions = {}): ReturnType {
  const map = useLeafletMap();

  const [markers, setMarkers] = useState<L.Marker[]>([]);
  const [displayRoutes, setDisplayRoutes] = useState<boolean>(false);
  const [hasInitialCentered, setHasInitialCentered] = useState<boolean>(false);

  const zoomIn = useCallback(() => {
    map.zoomIn();
  }, [map]);

  const zoomOut = useCallback(() => {
    map.zoomOut();
  }, [map]);

  const toggleRoutes = useCallback(() => {
    setDisplayRoutes((prev) => !prev);
  }, []);

  const centerVisibleMarkers = useCallback(() => {
    const mapBounds = map.getBounds();
    const visibleMarkers = markers.filter((marker) => mapBounds.contains(marker.getLatLng()));

    if (visibleMarkers.length === 0) {
      return;
    }

    if (visibleMarkers.length === 1) {
      map.panTo(visibleMarkers[0].getLatLng());

      return;
    }

    const bounds = L.latLngBounds(visibleMarkers.map((marker) => marker.getLatLng()));

    map.fitBounds(bounds, {
      padding: [50, 50],
    });
  }, [map, markers]);

  useEffect(() => {
    if (!map) {
      return;
    }

    const initialMarkers: L.Marker[] = [];

    map.eachLayer((layer) => {
      if (layer instanceof L.Marker) {
        initialMarkers.push(layer);
      }
    });

    setMarkers(initialMarkers);

    const handleAdd = (e: L.LayerEvent) => {
      if (e.layer instanceof L.Marker) {
        setMarkers((prevMarkers) => [...prevMarkers, e.layer as L.Marker]);
      }
    };

    const handleRemove = (e: L.LayerEvent) => {
      if (e.layer instanceof L.Marker) {
        setMarkers((prevMarkers) => prevMarkers.filter((marker) => marker !== e.layer));
      }
    };

    map.on('layeradd', handleAdd);
    map.on('layerremove', handleRemove);

    return () => {
      map.off('layeradd', handleAdd);
      map.off('layerremove', handleRemove);
    };
  }, [map]);

  const locations = useMemo(() => {
    return markers.map((marker) => {
      const latLng = marker.getLatLng();

      return [latLng.lat, latLng.lng] as LatLngExpression;
    });
  }, [markers]);

  const weightedMarkerCentroid = useMemo<LatLngExpression | undefined>(() => {
    if (!locations.length) {
      return;
    }

    if (locations.length === 1) {
      return locations[0];
    }

    // Calculate cluster-weighted centroid
    const clusterRadius = 0.1;
    let totalWeight = 0;
    let weightedLatSum = 0;
    let weightedLngSum = 0;

    locations.forEach((location) => {
      const [lat, lng] = location as [number, number];

      // Count nearby markers to determine cluster density
      const nearbyCount = locations.filter((otherLocation) => {
        const [otherLat, otherLng] = otherLocation as [number, number];
        const distance = Math.sqrt(Math.pow(lat - otherLat, 2) + Math.pow(lng - otherLng, 2));

        return distance <= clusterRadius;
      }).length;

      // Weight is the square root of cluster density to avoid over-weighting
      const weight = Math.sqrt(nearbyCount);

      totalWeight += weight;
      weightedLatSum += lat * weight;
      weightedLngSum += lng * weight;
    });

    return [weightedLatSum / totalWeight, weightedLngSum / totalWeight];
  }, [locations]);

  // Center map on marker centroid when map is ready and markers are available
  useEffect(() => {
    if (!autoCenterMarkers || !map || !weightedMarkerCentroid || hasInitialCentered) {
      return;
    }

    map.whenReady(() => {
      if (map.getContainer() && weightedMarkerCentroid) {
        map.setView(weightedMarkerCentroid as [number, number], map.getZoom());
        setHasInitialCentered(true);
      }
    });
  }, [autoCenterMarkers, map, weightedMarkerCentroid, hasInitialCentered]);

  return [
    {
      locations,
      displayRoutes,
    },
    {
      toggleRoutes,
      zoomIn,
      zoomOut,
      centerVisibleMarkers,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useMap);

export { Provider as MapProvider, useHookContext as useMap };
