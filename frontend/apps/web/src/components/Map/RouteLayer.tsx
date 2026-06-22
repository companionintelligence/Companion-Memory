import { useEffect, useMemo } from 'react';

import L, { type LatLngExpression } from 'leaflet';
import { useMap as useLeafletMap } from 'react-leaflet';

import { isGoogleMapsConfigured, loadGoogleMaps } from './googleMaps';
import { useMap } from './useMap';

class RouteEngine extends L.LayerGroup {
  // Monotonic generation token. update() is async (it awaits the Google
  // Directions API per segment), so without a guard two overlapping calls would
  // interleave their clearLayers()/addLayer() and leave orphaned routes from the
  // stale call. Each update() captures the generation it started in; any async
  // continuation bails the moment a newer update() has bumped it.
  private generation = 0;

  async update(locations: L.LatLng[]): Promise<void> {
    const generation = ++this.generation;

    this.clearLayers();

    if (locations.length < 2) {
      return;
    }

    // `locations` arrives already ordered by visit time, so connect consecutive
    // points as-is — no re-sorting by latitude (which scrambled the path order).
    for (let i = 0; i < locations.length - 1; i++) {
      if (generation !== this.generation) {
        return;
      }

      await this.createRoadRoute(locations[i], locations[i + 1], generation);
    }
  }

  private async createRoadRoute(start: L.LatLng, end: L.LatLng, generation: number): Promise<void> {
    try {
      await loadGoogleMaps();

      if (generation !== this.generation) {
        return;
      }

      const directionsService = new window.google.maps.DirectionsService();

      const request: google.maps.DirectionsRequest = {
        origin: new window.google.maps.LatLng(start.lat, start.lng),
        destination: new window.google.maps.LatLng(end.lat, end.lng),
        travelMode: window.google.maps.TravelMode.DRIVING,
      };

      const result = await directionsService.route(request);

      if (generation !== this.generation) {
        return;
      }

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

      if (generation !== this.generation) {
        return;
      }

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

export function RouteLayer({ locations = [] }: { locations?: LatLngExpression[] }) {
  const map = useLeafletMap();
  const [{ displayRoutes }] = useMap();

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
