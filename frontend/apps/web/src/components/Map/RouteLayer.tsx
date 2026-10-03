import { useEffect, useMemo, useState } from 'react';

import L, { type LatLngExpression } from 'leaflet';
import { useMap as useLeafletMap } from 'react-leaflet';

import { useSessionAuth } from '@/hooks/useSessionAuth';

import {
  isGoogleMapsConfigured,
  loadGoogleMaps,
  resolveGoogleMapsApiKey,
  type MapsSession,
} from './googleMaps';
import { useMap } from './useMap';

class RouteEngine extends L.LayerGroup {
  // Monotonic generation token. update() is async (it awaits the Google
  // Directions API per segment), so without a guard two overlapping calls would
  // interleave their clearLayers()/addLayer() and leave orphaned routes from the
  // stale call. Each update() captures the generation it started in; any async
  // continuation bails the moment a newer update() has bumped it.
  private generation = 0;

  private session: MapsSession | null = null;

  setSession(session: MapsSession | null) {
    this.session = session;
  }

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
      await loadGoogleMaps(this.session);
    } catch (error) {
      console.warn('Google Maps Directions API failed, creating fallback route.', error);

      if (generation !== this.generation) {
        return;
      }

      this.createFallbackRoute(start, end);

      return;
    }

    if (generation !== this.generation) {
      return;
    }

    try {
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
  // `ready`, not the web JWT: the native shell never has one — its credential is a keystore API key —
  // and gating on the token left the phone's map without its route layer.
  const { ready, headers } = useSessionAuth();
  const session = useMemo<MapsSession>(() => ({ ready, headers }), [ready, headers]);
  const [configured, setConfigured] = useState(() => isGoogleMapsConfigured());

  const engine = useMemo(() => new RouteEngine(), []);

  useEffect(() => {
    engine.setSession(session);
  }, [engine, session]);

  // Resolve Hub-injected runtime key when Vite did not bake one in.
  useEffect(() => {
    let cancelled = false;

    void resolveGoogleMapsApiKey(session).then((key) => {
      if (!cancelled) {
        setConfigured(Boolean(key));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [session]);

  // Route drawing depends on the billed Google Directions API. When no key is
  // configured, skip the layer entirely so we never hit the API (which would
  // otherwise emit a REQUEST_DENIED / billing error per location pair on load).
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

    void engine.update(latLngs);
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
