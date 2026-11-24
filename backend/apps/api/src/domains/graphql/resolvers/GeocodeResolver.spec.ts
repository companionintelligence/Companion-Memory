import { GeocodeResolver } from './GeocodeResolver';

describe('GeocodeResolver', () => {
  it('returns the place name from reverse geocode', async () => {
    const geocodeService = {
      reverseGeocode: jest.fn().mockResolvedValue({
        status: 'OK',
        placeName: '66 Mint St, San Francisco',
      }),
    };
    const resolver = new GeocodeResolver(geocodeService as never);

    await expect(resolver.reverseGeocode(37.7823, -122.4076)).resolves.toEqual({
      status: 'OK',
      placeName: '66 Mint St, San Francisco',
    });
    expect(geocodeService.reverseGeocode).toHaveBeenCalledWith(37.7823, -122.4076);
  });

  it('turns a place name into coordinates and the address to confirm by', async () => {
    const geocodeService = {
      geocode: jest.fn().mockResolvedValue({
        status: 'OK',
        point: { type: 'Point', coordinates: [-122.4076, 37.7823] },
        confidence: 0.9,
        cached: true,
        retryable: false,
        normalizedAddress: '66 Mint St, San Francisco, CA 94103, USA',
      }),
    };
    const resolver = new GeocodeResolver(geocodeService as never);

    await expect(resolver.geocode('  66 Mint St ')).resolves.toEqual({
      status: 'OK',
      latitude: 37.7823,
      longitude: -122.4076,
      normalizedAddress: '66 Mint St, San Francisco, CA 94103, USA',
      confidence: 0.9,
      cached: true,
    });
    expect(geocodeService.geocode).toHaveBeenCalledWith('66 Mint St');
  });

  it('reports no match without coordinates', async () => {
    const geocodeService = {
      geocode: jest.fn().mockResolvedValue({
        status: 'ZERO_RESULTS',
        point: null,
        confidence: null,
        cached: false,
        retryable: false,
      }),
    };
    const resolver = new GeocodeResolver(geocodeService as never);

    await expect(resolver.geocode('nowhere in particular')).resolves.toMatchObject({
      status: 'ZERO_RESULTS',
      latitude: null,
      longitude: null,
      normalizedAddress: null,
    });
  });

  it('answers a blank name itself rather than spending a provider call on it', async () => {
    const geocodeService = { geocode: jest.fn() };
    const resolver = new GeocodeResolver(geocodeService as never);

    await expect(resolver.geocode('   ')).resolves.toMatchObject({ status: 'ZERO_RESULTS', cached: false });
    expect(geocodeService.geocode).not.toHaveBeenCalled();
  });
});
