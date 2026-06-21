import { useEffect, useMemo } from 'react';

import L from 'leaflet';
import { useMap as useLeafletMap } from 'react-leaflet';

import { isGoogleMapsConfigured, loadGoogleMaps } from './googleMaps';
import { useMap } from './useMap';

class RouteEngine extends L.LayerGroup {
  async update(locations: L.LatLng[]): Promise<void> {
    this.clearLayers();

    if (locations.length < 2) {
      return;
    }

    const sortedLocations = [...locations].sort((a, b) => b.lat - a.lat);

    for (let i = 0; i < sortedLocations.length - 1; i++) {
      const start = sortedLocations[i];
      const end = sortedLocations[i + 1];

      await this.createRoadRoute(start, end);
    }
  }

  private async createRoadRoute(start: L.LatLng, end: L.LatLng): Promise<void> {
    try {
      await loadGoogleMaps();

      const directionsService = new window.google.maps.DirectionsService();

      const request: google.maps.DirectionsRequest = {
        origin: new window.google.maps.LatLng(start.lat, start.lng),
        destination: new window.google.maps.LatLng(end.lat, end.lng),
        travelMode: window.google.maps.TravelMode.DRIVING,
      };

      const result = await directionsService.route(request);

      if (result.routes && result.routes.length > 0) {
        const waypoints = result.routes[0].overview_path.map(
          (p: google.maps.LatLng) => new L.LatLng(p.lat(), p.lng()),
        );

        const polyline = L.polyline(waypoints, {
          color: 'rgb(21, 93, 252)',
          weight: 5,
          opacity: 1,
          interactive: false,
        });

        this.addLayer(polyline);
      } else {
        this.createFallbackRoute(start, end);
      }
    } catch (error) {
      console.warn('Google Maps Directions API failed, creating fallback route.', error);

      this.createFallbackRoute(start, end);
    }
  }

  private createFallbackRoute(start: L.LatLng, end: L.LatLng): void {
    const waypoints: L.LatLng[] = [start, end];

    const polyline = L.polyline(waypoints, {
      color: 'rgb(21, 93, 252)',
      weight: 5,
      opacity: 0.8,
      interactive: false,
      dashArray: '15, 10',
    });

    this.addLayer(polyline);
  }
}

export function RouteLayer() {
  const map = useLeafletMap();
  const [{ locations, displayRoutes }] = useMap();

  const engine = useMemo(() => new RouteEngine(), []);

  // Route drawing depends on the billed Google Directions API. When no key is
  // configured, skip the layer entirely so we never hit the API (which would
  // otherwise emit a REQUEST_DENIED / billing error per location pair on load).
  const configured = isGoogleMapsConfigured();

  useEffect(() => {
    if (!configured) {
      return;
    }

    map.addLayer(engine);

    return () => {
      map.removeLayer(engine);
    };
  }, [map, engine, configured]);

  useEffect(() => {
    if (!configured) {
      return;
    }

    const latLngs = locations.map((loc) => L.latLng(loc));

    engine.update(latLngs);
  }, [locations, engine, configured]);

  useEffect(() => {
    if (!configured) {
      return;
    }

    if (displayRoutes) {
      map.addLayer(engine);
    } else {
      map.removeLayer(engine);
    }
  }, [displayRoutes, engine, map, configured]);

  return null;
}
