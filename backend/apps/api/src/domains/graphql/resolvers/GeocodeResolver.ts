import { UseGuards } from '@nestjs/common';
import { Args, Float, Query, Resolver } from '@nestjs/graphql';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { GeocodeService } from '@ci/domains/geocode';

import { ReverseGeocodeResultType } from '../types/ReverseGeocodeResultType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver()
export class GeocodeResolver {
  constructor(private readonly geocodeService: GeocodeService) {}

  /**
   * Turn a GPS fix into an address. Used when the user drops a pin from the
   * phone's current location so the place is named, not just a coordinate pair.
   */
  @Query(() => ReverseGeocodeResultType)
  async reverseGeocode(
    @Args('latitude', { type: () => Float }) latitude: number,
    @Args('longitude', { type: () => Float }) longitude: number,
  ): Promise<ReverseGeocodeResultType> {
    const outcome = await this.geocodeService.reverseGeocode(latitude, longitude);

    return { status: outcome.status, placeName: outcome.placeName };
  }
}
