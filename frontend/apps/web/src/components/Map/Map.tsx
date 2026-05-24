import { type ReactNode } from 'react';

import { type LatLngExpression } from 'leaflet';
import { MapContainer, TileLayer } from 'react-leaflet';

import 'leaflet/dist/leaflet.css';

import { Controls } from './Controls';
import { Marker } from './Marker';
import { Panel } from './Panel';
import { RouteLayer } from './RouteLayer';
import { MapProvider } from './useMap';

interface Props {
  center?: LatLngExpression;
  children?: ReactNode;
  zoom?: number;
  zoomEnabled?: boolean;
  draggingEnabled?: boolean;
}

export function Map({ center, children, zoom = 13, zoomEnabled = true, draggingEnabled = true }: Props) {
  return (
    <div className="relative w-full h-full" style={{ zIndex: 1 }}>
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%' }} // map must have size
        scrollWheelZoom={zoomEnabled}
        dragging={draggingEnabled}
        attributionControl={false}
        zoomControl={false}
      >
        <MapProvider args={[]}>
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" />

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
