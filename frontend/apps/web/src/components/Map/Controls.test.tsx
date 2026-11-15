import { fireEvent, render, screen } from '@testing-library/react';
import L from 'leaflet';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Controls } from './Controls';
import { MapProvider } from './useMap';

// No <MapContainer> here: the controls drive a stand-in map holding two markers, one in
// San Francisco and one in New York, and record how it is asked to frame them.
const h = vi.hoisted(() => ({
  map: {
    eachLayer: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getBounds: vi.fn(),
    getZoom: vi.fn(),
    project: vi.fn(),
    unproject: vi.fn(),
    fitBounds: vi.fn(),
    panTo: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  },
}));

vi.mock('react-leaflet', () => ({ useMap: () => h.map }));

const markers = [L.marker([37.77, -122.42]), L.marker([40.71, -74.0])];
const ZOOM = 6;
const pixelX = (latLng: L.LatLngExpression) => L.CRS.EPSG3857.latLngToPoint(L.latLng(latLng), ZOOM).x;

beforeEach(() => {
  vi.clearAllMocks();
  h.map.eachLayer.mockImplementation((visit: (layer: L.Layer) => void) => markers.forEach(visit));
  h.map.getBounds.mockReturnValue(L.latLngBounds([20, -130], [50, -60]));
  h.map.getZoom.mockReturnValue(ZOOM);
  h.map.project.mockImplementation((latLng: L.LatLngExpression, zoom: number) =>
    L.CRS.EPSG3857.latLngToPoint(L.latLng(latLng), zoom),
  );
  h.map.unproject.mockImplementation((point: L.PointExpression, zoom: number) =>
    L.CRS.EPSG3857.pointToLatLng(L.point(point), zoom),
  );
});

function renderControls(panelInset?: number) {
  render(
    <MapProvider args={[{ autoCenterMarkers: false }]}>
      <Controls position="top-right" panelInset={panelInset} />
    </MapProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Center visible pins' }));
}

describe('Center visible pins', () => {
  it('frames the visible pins with even padding on a map nothing covers', () => {
    renderControls();

    expect(h.map.fitBounds).toHaveBeenCalledWith(expect.any(L.LatLngBounds), {
      paddingTopLeft: [50, 50],
      paddingBottomRight: [50, 50],
    });
  });

  it('frames them right of a panel over the left edge, as on the desktop timeline map', () => {
    renderControls(300);

    expect(h.map.fitBounds).toHaveBeenCalledWith(expect.any(L.LatLngBounds), {
      paddingTopLeft: [350, 50],
      paddingBottomRight: [50, 50],
    });
  });

  it('centres a single visible pin on the map when nothing covers it', () => {
    h.map.getBounds.mockReturnValue(L.latLngBounds([30, -130], [45, -100]));
    renderControls();

    expect(h.map.panTo).toHaveBeenCalledWith(markers[0].getLatLng());
  });

  it('centres a single visible pin in the part a panel over the left edge leaves uncovered', () => {
    h.map.getBounds.mockReturnValue(L.latLngBounds([30, -130], [45, -100]));
    renderControls(300);

    // The map's centre sits half the panel's width left of the pin, so the pin
    // lands in the middle of what the panel leaves showing.
    const [center] = h.map.panTo.mock.calls[0] as [L.LatLngExpression];

    expect(pixelX(markers[0].getLatLng()) - pixelX(center)).toBeCloseTo(150);
    expect(L.latLng(center).lat).toBeCloseTo(markers[0].getLatLng().lat);
  });
});
