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
});
