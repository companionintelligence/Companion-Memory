import { describe, expect, it } from 'vitest';

import {
  fitActionFor,
  fitSignature,
  mostRecentDatedPin,
  pinsInBounds,
  routePoints,
  type BoundsLike,
} from './pinSet';

function pin(id: string, lat: number, lng: number) {
  return { id, coords: { lat, lng } };
}

/** Stand-in for Leaflet's LatLngBounds: a plain rectangle. */
function box(minLat: number, minLng: number, maxLat: number, maxLng: number): BoundsLike {
  return {
    contains: ([lat, lng]) => lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng,
    getWest: () => minLng,
    getEast: () => maxLng,
  };
}

describe('pinsInBounds', () => {
  it('keeps only the pins inside the viewport', () => {
    const pins = [pin('a', 37.77, -122.42), pin('b', 51.5, -0.12), pin('c', 37.8, -122.3)];

    expect(pinsInBounds(pins, box(37, -123, 38, -122)).map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('returns an empty set when nothing is on screen — never the whole set', () => {
    expect(pinsInBounds([pin('a', 37.77, -122.42)], box(0, 0, 1, 1))).toEqual([]);
  });

  it('preserves order, so the route and the fit signature stay stable', () => {
    const pins = [pin('a', 1, 1), pin('b', 2, 2), pin('c', 3, 3)];

    expect(pinsInBounds(pins, box(0, 0, 10, 10)).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  // A view panned round the globe reports bounds past ±180°; a pin on the
  // other side of the seam is in that view, on the neighbouring copy of the
  // world, and must be drawn there — Leaflet places a marker only where its
  // own longitude says, so the copy was bare.
  it('places a pin across the antimeridian on the copy of the world in view', () => {
    const fiji = pin('fiji', -17.7, 178.1);
    const samoa = pin('samoa', -13.8, -171.8);

    const eastward = pinsInBounds([fiji, samoa], box(-30, 170, 0, 195));

    expect(eastward.map((p) => [p.id, p.coords.lng])).toEqual([
      ['fiji', 178.1],
      ['samoa', 188.2],
    ]);

    const westward = pinsInBounds([fiji, samoa], box(-30, -195, 0, -165));

    expect(westward.map((p) => [p.id, p.coords.lng])).toEqual([
      ['fiji', -181.9],
      ['samoa', -171.8],
    ]);
  });

  it('follows the view any number of worlds round, in either direction', () => {
    const home = pin('home', 37.77, -122.42);

    expect(pinsInBounds([home], box(30, 590, 40, 610))[0].coords.lng).toBeCloseTo(597.58);
    expect(pinsInBounds([home], box(30, -850, 40, -840))[0].coords.lng).toBeCloseTo(-842.42);
  });

  it('keeps the original object, untouched, for a pin on the primary copy', () => {
    const home = pin('home', 37.77, -122.42);

    expect(pinsInBounds([home], box(30, -130, 40, -120))[0]).toBe(home);
    expect(home.coords.lng).toBe(-122.42);
  });

  it('draws each pin once even when the box reaches more than one of its copies', () => {
    const placed = pinsInBounds([pin('a', 0, 10)], box(-10, -400, 10, 400));

    expect(placed).toHaveLength(1);
    expect([-350, 10, 370]).toContain(placed[0].coords.lng);
  });
});

describe('routePoints', () => {
  const pins = Array.from({ length: 120 }, (_, index) => pin(`p${index}`, index, index));

  it('caps the route at `max` points — one billed directions call per pair', () => {
    expect(routePoints(pins, 50)).toHaveLength(50);
  });

  it('keeps the MOST RECENT stretch (pins are time-ascending)', () => {
    const points = routePoints(pins, 3);

    expect(points).toEqual([
      [117, 117],
      [118, 118],
      [119, 119],
    ]);
  });

  it('returns everything when the set is under the cap', () => {
    expect(routePoints([pin('a', 1, 2), pin('b', 3, 4)], 50)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('handles an empty set', () => {
    expect(routePoints([], 50)).toEqual([]);
  });
});

describe('mostRecentDatedPin', () => {
  it('opens around the latest real event instead of fitting a worldwide library', () => {
    const pins = [
      { ...pin('london', 51.5, -0.12), sortTime: 100 },
      { ...pin('tokyo', 35.68, 139.69), sortTime: 300 },
      { ...pin('import-only', 0, 0), sortTime: 0 },
      { ...pin('new-york', 40.71, -74), sortTime: 200 },
    ];

    expect(mostRecentDatedPin(pins)?.id).toBe('tokyo');
  });

  it('returns null when every mapped event is undated', () => {
    expect(mostRecentDatedPin([{ ...pin('saved-place', 1, 2), sortTime: 0 }])).toBeNull();
  });
});

describe('fitSignature', () => {
  it('is empty for an empty set, so nothing is fitted to nothing', () => {
    expect(fitSignature([])).toBe('');
  });

  it('is stable for the same set', () => {
    const pins = [pin('a', 1, 1), pin('b', 2, 2)];

    expect(fitSignature(pins)).toBe(fitSignature([...pins]));
  });

  it('changes when the set grows — a new filter refits the viewport', () => {
    const pins = [pin('a', 1, 1), pin('b', 2, 2)];

    expect(fitSignature([...pins, pin('c', 3, 3)])).not.toBe(fitSignature(pins));
  });

  it('changes when the endpoints change at the same size', () => {
    expect(fitSignature([pin('a', 1, 1), pin('b', 2, 2)])).not.toBe(
      fitSignature([pin('a', 1, 1), pin('z', 2, 2)]),
    );
  });
});

describe('fitActionFor', () => {
  it('moves nothing for an empty set, or one the viewport already follows', () => {
    expect(fitActionFor({ signature: '', fitted: null, areaBound: false, previousAreaBound: false })).toBe(
      'none',
    );
    expect(
      fitActionFor({ signature: '3:a:c', fitted: '3:a:c', areaBound: false, previousAreaBound: false }),
    ).toBe('none');
  });

  it('fits to the pins when a filter changes the set', () => {
    expect(
      fitActionFor({ signature: '3:a:c', fitted: '2:a:b', areaBound: false, previousAreaBound: false }),
    ).toBe('pins');
    expect(
      fitActionFor({ signature: '3:a:c', fitted: null, areaBound: false, previousAreaBound: false }),
    ).toBe('pins');
  });

  // "Search events in this area": the viewport IS the box the person framed.
  // Fitting to the pins inside it re-centred and zoomed the map they had just
  // set up, which brought the search button back at once. A box drawn from
  // the viewport is on screen by definition, so it is never re-framed.
  it('leaves a viewport the person framed alone when its area search lands', () => {
    expect(
      fitActionFor({
        signature: '2:a:b',
        fitted: '9:a:z',
        areaBound: true,
        previousAreaBound: false,
        areaChanged: true,
        areaInView: true,
      }),
    ).toBe('none');
  });

  it('frames the area when a box the viewport does not show arrives, as from a saved search', () => {
    // Cold load with the box already in the URL, from the default city.
    expect(
      fitActionFor({
        signature: '2:a:b',
        fitted: null,
        areaBound: true,
        previousAreaBound: false,
        areaChanged: true,
        areaInView: false,
      }),
    ).toBe('area');
    // Picking another saved search in-page, while looking at the last one.
    expect(
      fitActionFor({
        signature: '4:c:f',
        fitted: '2:a:b',
        areaBound: true,
        previousAreaBound: true,
        areaChanged: true,
        areaInView: false,
      }),
    ).toBe('area');
  });

  it('frames the area even when the search inside it found nothing', () => {
    expect(
      fitActionFor({
        signature: '',
        fitted: null,
        areaBound: true,
        previousAreaBound: false,
        areaChanged: true,
        areaInView: false,
      }),
    ).toBe('area');
  });

  it('stays put when the same area comes back with a different set', () => {
    expect(
      fitActionFor({
        signature: '3:a:c',
        fitted: '2:a:b',
        areaBound: true,
        previousAreaBound: true,
        areaChanged: false,
        areaInView: false,
      }),
    ).toBe('none');
  });

  it('stays put when the area filter is dropped and the whole set comes back', () => {
    expect(
      fitActionFor({ signature: '9:a:z', fitted: '2:a:b', areaBound: false, previousAreaBound: true }),
    ).toBe('none');
  });

  it('fits again on the next real filter change after an area search', () => {
    expect(
      fitActionFor({ signature: '4:a:d', fitted: '9:a:z', areaBound: false, previousAreaBound: false }),
    ).toBe('pins');
  });
});
