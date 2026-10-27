import { useLazyQuery } from '@apollo/client';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePlaceLookup } from './usePlaceLookup';

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
});
