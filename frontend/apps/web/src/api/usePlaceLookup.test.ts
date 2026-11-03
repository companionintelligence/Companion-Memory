import { useLazyQuery } from '@apollo/client';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { namesTypedPlace, usePlaceLookup } from './usePlaceLookup';

vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useLazyQuery: vi.fn(),
}));

const mockedUseLazyQuery = vi.mocked(useLazyQuery);
const run = vi.fn();

beforeEach(() => {
  mockedUseLazyQuery.mockReturnValue([run, {}] as unknown as ReturnType<typeof useLazyQuery>);
});

afterEach(() => {
  mockedUseLazyQuery.mockReset();
  run.mockReset();
});

describe('usePlaceLookup', () => {
  // GeocodeService.confidenceForLocationType: 0.95 for a street address, 0.8 for
  // a venue or an unknown grade, 0.4 for APPROXIMATE (a city or region centroid).
  // The 0.4 case is the boundary: `<` instead of `<=` would let it through.
  it.each([
    [0.4, true],
    [0.8, false],
    [0.95, false],
    [null, false],
  ])('at confidence %s, approximate is %s', async (confidence, approximate) => {
    run.mockResolvedValue({
      data: {
        geocodingConfigured: true,
        geocode: {
          status: 'OK',
          latitude: 37.7749295,
          longitude: -122.4194155,
          normalizedAddress: 'San Francisco, CA, USA',
          confidence,
          cached: false,
        },
      },
    });
    const { result } = renderHook(() => usePlaceLookup());

    await expect(result.current('Blue Bottle Coffee, San Francisco')).resolves.toEqual({
      status: 'ok',
      latitude: 37.7749295,
      longitude: -122.4194155,
      address: 'San Francisco, CA, USA',
      approximate,
    });
    expect(run).toHaveBeenCalledWith({ variables: { query: 'Blue Bottle Coffee, San Francisco' } });
  });

  // A city looked up on purpose comes back APPROXIMATE too: the provider can only
  // place a city at its centre. That is the place asked for, so it fills in.
  it.each([
    ['Tokyo', 'Tokyo, Japan', false],
    ['tokyo', 'Tokyo, Japan', false],
    ['San Francisco', 'San Francisco, CA, USA', false],
    ['Blue Bottle Coffee, San Francisco', 'San Francisco, CA, USA', true],
  ])('a lookup for %j that finds %j is approximate: %s', async (query, normalizedAddress, approximate) => {
    run.mockResolvedValue({
      data: {
        geocodingConfigured: true,
        geocode: {
          status: 'OK',
          latitude: 35.6764225,
          longitude: 139.650027,
          normalizedAddress,
          confidence: 0.4,
          cached: false,
        },
      },
    });
    const { result } = renderHook(() => usePlaceLookup());

    await expect(result.current(query)).resolves.toEqual(
      expect.objectContaining({ status: 'ok', approximate }),
    );
  });
});

describe('namesTypedPlace', () => {
  it.each([
    ['Tokyo', 'Tokyo, Japan'],
    ['Paris, France', 'Paris, France'],
    ['Portland, OR', 'Portland, OR, USA'],
    ['  sao   paulo ', 'São Paulo, State of São Paulo, Brazil'],
  ])('%j names %j', (query, address) => {
    expect(namesTypedPlace(query, address)).toBe(true);
  });

  it.each([
    ['Blue Bottle Coffee, San Francisco', 'San Francisco, CA, USA'],
    ['Portland, Maine', 'Portland, OR, USA'],
    ['Tokio', 'Tokyo, Japan'],
    ['Japan, Tokyo', 'Tokyo, Japan'],
    ['', 'Tokyo, Japan'],
    ['Tokyo', null],
  ])('%j does not name %j', (query, address) => {
    expect(namesTypedPlace(query, address)).toBe(false);
  });
});
