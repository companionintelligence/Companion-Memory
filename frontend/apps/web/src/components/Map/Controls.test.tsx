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
    fitBounds: vi.fn(),
    panTo: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  },
}));

vi.mock('react-leaflet', () => ({ useMap: () => h.map }));

const markers = [L.marker([37.77, -122.42]), L.marker([40.71, -74.0])];

beforeEach(() => {
  vi.clearAllMocks();
  h.map.eachLayer.mockImplementation((visit: (layer: L.Layer) => void) => markers.forEach(visit));
  h.map.getBounds.mockReturnValue(L.latLngBounds([20, -130], [50, -60]));
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
});
