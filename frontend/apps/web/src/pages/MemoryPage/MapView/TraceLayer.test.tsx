import type { ReactNode } from 'react';

import { useQuery } from '@apollo/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { LatLngBounds } from 'leaflet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boundsToBbox } from '../bbox';

import { PositionTraceLayer, TraceToggleControl } from './TraceLayer';

/**
 * `PositionTraceLayer` needs a real Leaflet map instance for `useMap` /
 * `useMapEvents` — normally supplied by an ancestor `<MapContainer>`. Standing
 * one up under jsdom just to read a bounding box back out is not worth it:
 * this fakes the tiny slice of the Leaflet `Map` API the layer actually calls
 * (`getBounds().pad(...)`), including a real implementation of `pad` (mirrors
 * Leaflet's own `LatLngBounds.pad`), so the bbox the test computes and the
 * bbox the component derives are computed the SAME way rather than two
 * independently-hand-written formulas that could agree by coincidence.
 *
 * `vi.hoisted` because `vi.mock('react-leaflet', ...)` below is hoisted above
 * this module's imports, and needs `leafletState` to already exist when it
 * runs.
 */
const leafletState = vi.hoisted(() => {
  function makeBounds(west: number, south: number, east: number, north: number) {
    return {
      pad(ratio: number) {
        const latBuffer = Math.abs(south - north) * ratio;
        const lngBuffer = Math.abs(west - east) * ratio;

        return makeBounds(west - lngBuffer, south - latBuffer, east + lngBuffer, north + latBuffer);
      },
      getWest: () => west,
      getSouth: () => south,
      getEast: () => east,
      getNorth: () => north,
    };
  }

  let bounds = makeBounds(-122.6, 37.6, -122.2, 37.9);
  let handlers: Record<string, (() => void) | undefined> = {};

  return {
    makeBounds,
    map: {
      getBounds: () => bounds,
      fitBounds: () => {},
    },
    setBounds: (west: number, south: number, east: number, north: number) => {
      bounds = makeBounds(west, south, east, north);
    },
    registerHandlers: (next: Record<string, (() => void) | undefined>) => {
      handlers = next;
    },
    /** Simulates Leaflet firing `moveend` after a pan or zoom settles. */
    fireMoveEnd: () => handlers.moveend?.(),
  };
});

// No real <MapContainer> ancestor exists in this test, so react-leaflet's own
// useMap/useMapEvents/CircleMarker/Polyline/Tooltip (which all read a Leaflet
// context that only a <MapContainer> provides) are replaced outright rather
// than partially — pulling in the real ones would throw on the missing
// context for pieces this test doesn't care about (the drawn markers/line).
vi.mock('react-leaflet', () => ({
  useMap: () => leafletState.map,
  useMapEvents: (handlers: Record<string, () => void>) => {
    leafletState.registerHandlers(handlers);

    return leafletState.map;
  },
  CircleMarker: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Polyline: () => null,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

// Same technique as useEntityService.test.tsx / useSearchService.test.ts: mock
// Apollo's useQuery directly so the variables it's called with can be
// asserted without standing up a real network layer.
vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useQuery: vi.fn(),
}));

const SEARCH_START = '2024-01-01T00:00:00.000Z';
const SEARCH_END = '2024-02-01T00:00:00.000Z';

vi.mock('@/pages/MemoryPage/useEntityService', () => ({
  useEntityService: () => [{ searchVariables: { startTime: SEARCH_START, endTime: SEARCH_END } }, {}],
}));

const mockedUseQuery = vi.mocked(useQuery);

function setResult(overrides: Partial<{ data: unknown; loading: boolean; error: unknown }> = {}) {
  mockedUseQuery.mockReturnValue({
    data: undefined,
    loading: false,
    error: undefined,
    fetchMore: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useQuery>);
}

function lastOptions() {
  return mockedUseQuery.mock.calls.at(-1)?.[1] as {
    variables: { startTime?: string; endTime?: string; bbox?: number[]; first?: number; maxPoints?: number };
    skip: boolean;
  };
}

/**
 * The bbox `PositionTraceLayer` would derive from the map's CURRENT bounds
 * right now — real `boundsToBbox`, applied to the fake bounds object, which
 * only duck-types `LatLngBounds` (it need carry no more than what
 * `boundsToBbox` and `.pad` actually touch).
 */
function currentBbox() {
  return boundsToBbox(leafletState.map.getBounds().pad(0.35) as unknown as LatLngBounds);
}

beforeEach(() => setResult());
afterEach(() => mockedUseQuery.mockReset());

describe('PositionTraceLayer', () => {
  it("queries the caller's date filters and an unbounded viewport on first mount", () => {
    render(<PositionTraceLayer enabled fitToTrace={false} />);

    const { variables, skip } = lastOptions();

    expect(skip).toBe(false);
    expect(variables.startTime).toBe(SEARCH_START);
    expect(variables.endTime).toBe(SEARCH_END);
    // Deliberately starts unbounded — the map opens far from wherever this
    // user's history actually is, so seeding the first read from that
    // viewport would ask "what happened here" and get nothing back.
    expect(variables.bbox).toBeUndefined();
    // The page size and the point budget are DELIBERATELY different (see the
    // constants' doc comment in TraceLayer.tsx): a budget equal to the page
    // size means `hasNextPage` can never be true, and the keyset auto-pager
    // never has anything to page through.
    expect(variables.first).toBe(2_000);
    expect(variables.maxPoints).toBe(10_000);
  });

  it('skips the query while the layer is switched off, but still calls the hook (never conditionally)', () => {
    render(<PositionTraceLayer enabled={false} fitToTrace={false} />);

    expect(lastOptions().skip).toBe(true);
  });

  it("re-queries with the viewport's own bbox once a pan or zoom settles (moveend)", () => {
    render(<PositionTraceLayer enabled fitToTrace={false} />);

    expect(lastOptions().variables.bbox).toBeUndefined();

    act(() => {
      leafletState.fireMoveEnd();
    });

    // The component pads the raw viewport (see TRACE_VIEWPORT_PAD in
    // TraceLayer.tsx) before turning it into a bbox — currentBbox()'s 0.35
    // mirrors that constant, and calls the SAME real boundsToBbox the
    // component does, not a re-derivation of it.
    expect(lastOptions().variables.bbox).toEqual(currentBbox());
    // The date filters must survive the pan untouched.
    expect(lastOptions().variables.startTime).toBe(SEARCH_START);
    expect(lastOptions().variables.endTime).toBe(SEARCH_END);
  });

  it('re-derives the bbox from wherever the viewport pans to, not a stale one from an earlier pan', () => {
    render(<PositionTraceLayer enabled fitToTrace={false} />);

    act(() => {
      leafletState.fireMoveEnd();
    });
    const firstBbox = lastOptions().variables.bbox;

    // A city-sized box nowhere near the default San-Francisco-ish one above —
    // this is what a real pan to Los Angeles would report.
    leafletState.setBounds(-118.9, 33.5, -117.6, 34.8);

    act(() => {
      leafletState.fireMoveEnd();
    });

    const secondBbox = lastOptions().variables.bbox;

    expect(secondBbox).toEqual(currentBbox());
    expect(secondBbox).not.toEqual(firstBbox);
  });

  it('keeps its status line above the playback bar on desktop rather than in the corner the bar covers', () => {
    setResult({ loading: true });
    render(<PositionTraceLayer enabled fitToTrace={false} />);

    // jsdom has no layout, so this pins the placement: the bar spans the map's
    // bottom edge at the same z-index, and a status at bottom-4 sat under it.
    const wrapper = screen.getByText('Loading your location history…').parentElement;

    expect(wrapper).toHaveClass('device:bottom-20');
    expect(wrapper).not.toHaveClass('device:bottom-4');
  });
});

describe('TraceToggleControl', () => {
  it('shows the mobile history state compactly and keeps the full accessible action', () => {
    const onToggle = vi.fn();

    render(<TraceToggleControl enabled={false} onToggle={onToggle} compact />);

    const toggle = screen.getByRole('button', { name: 'Show location history' });

    expect(toggle).toHaveTextContent('HistoryOff');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
