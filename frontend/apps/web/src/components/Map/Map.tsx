import { useEffect, type ReactNode } from 'react';

import L, { type LatLngExpression } from 'leaflet';
import { MapContainer, TileLayer, useMap as useLeafletMap } from 'react-leaflet';

import 'leaflet/dist/leaflet.css';

import { Controls } from './Controls';
import { registerMap } from './mapIsolation';
import { Marker } from './Marker';
import { Panel } from './Panel';
import { RouteLayer } from './RouteLayer';
import { MapProvider } from './useMap';
import { worldFillMinZoom } from './worldFill';

interface Props {
  center?: LatLngExpression;
  children?: ReactNode;
  zoom?: number;
  zoomEnabled?: boolean;
  draggingEnabled?: boolean;
  attributionControl?: boolean;
  autoCenterMarkers?: boolean;
}

export const MAP_IMAGERY_ATTRIBUTION =
  'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/** Lets the controls floating over this map find it through the DOM (see mapIsolation.ts). */
function RegisterMap() {
  const map = useLeafletMap();

  useEffect(() => {
    registerMap(map);
  }, [map]);

  return null;
}

/**
 * The band the view is kept inside: the world's top and bottom edges, as far
 * as Web Mercator draws them, and no sides to speak of. Tiles repeat sideways,
 * so a person can keep going round the globe; a ±180° box stopped them dead at
 * the antimeridian. Leaflet's `maxBounds` clamps both axes from one box, so the
 * sides are simply put far enough out never to be reached.
 */
const WORLD_BAND = L.latLngBounds([-85.0511, -1e6], [85.0511, 1e6]);

/**
 * Keep the tiles covering the viewport: never zoom out past the level where
 * the world is smaller than the container (see `worldFillMinZoom`), and never
 * pan the world's top or bottom edge inside it (`maxBounds` as `WORLD_BAND`,
 * with full viscosity on the container below so the drag stops dead rather
 * than springing back; sideways stays free). Without
 * this, fitting the viewport to a spread-out pin set on a phone landed at
 * zoom 1, with the map as a band and blank background above and below it.
 * Re-applied on resize: a rotation, or a panel opening, changes the answer.
 */
function FillViewport() {
  const map = useLeafletMap();

  useEffect(() => {
    const apply = () => {
      const size = map.getSize();
      const minZoom = worldFillMinZoom(size.x, size.y);

      map.setMinZoom(minZoom);
      map.setMaxBounds(WORLD_BAND);

      if (map.getZoom() < minZoom) {
        map.setZoom(minZoom);
      }
    };

    apply();
    map.on('resize', apply);

    return () => {
      map.off('resize', apply);
    };
  }, [map]);

  return null;
}

export function Map({
  center,
  children,
  zoom = 13,
  zoomEnabled = true,
  draggingEnabled = true,
  attributionControl = true,
  autoCenterMarkers = true,
}: Props) {
  return (
    <div
      data-testid="map-root"
      className="relative h-full w-full [&_.leaflet-control-attribution]:opacity-[0.65] [&_.leaflet-control-attribution]:transition-opacity [&_.leaflet-control-attribution:focus-within]:opacity-100 [&_.leaflet-control-attribution:hover]:opacity-100"
      style={{ zIndex: 1 }}
    >
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%' }} // map must have size
        scrollWheelZoom={zoomEnabled}
        dragging={draggingEnabled}
        zoomControl={false}
        attributionControl={attributionControl}
        maxBoundsViscosity={1}
        // No `worldCopyJump`: it brings the centre back onto the primary copy of
        // the world by moving the view a whole world's width in one step, and
        // every tile element is recreated at its new position and fades in from
        // nothing — a white flash on each crossing. Pins follow the view round
        // the globe on their own (`pinsInBounds` places each on the copy in view).
      >
        <RegisterMap />
        <FillViewport />
        <MapProvider args={[{ autoCenterMarkers }]}>
          {/* The basemap belongs to a third party, and rendering it contacts them on every
              tile — the one egress a fresh appliance performs with no key and no connector.
              Esri's World Imagery terms require the credit, and the attribution control is
              the only place the UI would name them, so it stays on. The product video's
              memory-map shot masked this selector for a while; it was masking an element
              that had been switched off here. See docs/architecture/third-party-egress.md. */}
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution={MAP_IMAGERY_ATTRIBUTION}
          />

          {children}
        </MapProvider>
      </MapContainer>
    </div>
  );
}

Map.Controls = Controls;
Map.Marker = Marker;
Map.Panel = Panel;
Map.RouteLayer = RouteLayer;
