import { useEffect, useMemo } from 'react';

import L, { type LatLngExpression } from 'leaflet';
import { useMap as useLeafletMap } from 'react-leaflet';

import { isGoogleMapsConfigured, loadGoogleMaps } from './googleMaps';
import { useMap } from './useMap';

class RouteEngine extends L.LayerGroup {
  // Monotonic token identifying the latest update() call. Each segment awaits the
  // (async) Directions API, so a fresh update() can start before the previous one
  // finishes; comparing against this token lets a superseded run bail out instead
  // of interleaving polylines from two different result sets onto the map.
  private runId = 0;

  // `locations` arrive pre-ordered by entity timestamp, so connect them in the
  // given order — drawing the actual path travelled rather than a latitude sort.
  async update(locations: L.LatLng[]): Promise<void> {
    const runId = ++this.runId;

    this.clearLayers();

    if (locations.length < 2) {
      return;
    }

    for (let i = 0; i < locations.length - 1; i++) {
      const polyline = await this.createRoadRoute(locations[i], locations[i + 1]);

      // A newer update() superseded this run while we awaited the Directions API
      // (or it was removed) — discard this segment so stale routes never appear.
      if (runId !== this.runId) {
        return;
      }

      this.addLayer(polyline);
    }
  }

  private async createRoadRoute(start: L.LatLng, end: L.LatLng): Promise<L.Polyline> {
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

        return L.polyline(waypoints, {
          color: 'rgb(21, 93, 252)',
          weight: 5,
          opacity: 1,
          interactive: false,
        });
      }

      return this.createFallbackRoute(start, end);
    } catch (error) {
      console.warn('Google Maps Directions API failed, creating fallback route.', error);

      return this.createFallbackRoute(start, end);
    }
  }

  private createFallbackRoute(start: L.LatLng, end: L.LatLng): L.Polyline {
    const waypoints: L.LatLng[] = [start, end];

    return L.polyline(waypoints, {
      color: 'rgb(21, 93, 252)',
      weight: 5,
      opacity: 0.8,
      interactive: false,
      dashArray: '15, 10',
    });
  }
}

interface Props {
  /**
   * Route waypoints in travel order (entity timestamp). Fed from the located
   * entities themselves — never the scraped map markers, which include cluster
   * centroids that would otherwise be stitched into the route.
   */
  locations?: LatLngExpression[];
}

export function RouteLayer({ locations = [] }: Props) {
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

    engine.update(latLngs).catch((error) => {
      console.warn('Failed to update route layer.', error);
    });
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
