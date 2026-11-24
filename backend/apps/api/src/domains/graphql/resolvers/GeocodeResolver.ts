import { UseGuards } from '@nestjs/common';
import { Args, Float, Query, Resolver } from '@nestjs/graphql';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { GeocodeService } from '@ci/domains/geocode';

import { GeocodeResultType } from '../types/GeocodeResultType';
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

  /**
   * Turn a typed place name into coordinates. The event form's "Look up".
   *
   * Goes through the same `GeocodeService` the import pipeline uses, cache
   * first, so a name already seen costs nothing and a new one costs one
   * provider call — a person's few lookups a day, not the pipeline's sweep.
   * A blank query is answered without reaching the service.
   */
  @Query(() => GeocodeResultType)
  async geocode(@Args('query', { type: () => String }) query: string): Promise<GeocodeResultType> {
    const trimmed = query.trim();

    if (!trimmed) {
      return {
        status: 'ZERO_RESULTS',
        latitude: null,
        longitude: null,
        normalizedAddress: null,
        confidence: null,
        cached: false,
      };
    }

    const outcome = await this.geocodeService.geocode(trimmed);
    const [longitude, latitude] = outcome.point?.coordinates ?? [null, null];

    return {
      status: outcome.status,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      normalizedAddress: outcome.normalizedAddress ?? null,
      confidence: outcome.confidence,
      cached: outcome.cached,
    };
  }
}
