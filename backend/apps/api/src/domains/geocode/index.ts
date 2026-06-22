/**
 * The geocode domain forward-geocodes free-text location names into PostGIS
 * coordinates (geodata-plan Phase 1).
 *
 * ### Key components
 * - **GeocodeService**: cache-aware orchestration — canonicalizes the query,
 *   checks ci.geocode_cache, calls the provider on a miss, branches on the
 *   provider `status` (NOT HTTP code), writes the (possibly negative) cache row,
 *   and returns a PostGIS-ready Point with a precision-derived confidence.
 * - **GoogleGeocodeProvider**: the only provider today (Google direct key).
 *   Bound to the {@link GEOCODE_PROVIDER} token so the orchestration stays
 *   provider-agnostic.
 * - **GeocodeBatchListener**: PGBoss `@OnEvent` worker for
 *   {@link GeocodeBatchRequestEvent}; concurrency-capped backfill that writes
 *   coordinates + confidence back onto events.
 *
 * @module GeocodeModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { MemoryModule } from '@ci/domains/memory';

import { GeocodeCacheEntity } from './entities/GeocodeCacheEntity';
import { GeocodeBatchListener } from './listeners/GeocodeBatchListener';
import { GEOCODE_PROVIDER } from './services/GeocodeProvider';
import { GeocodeService } from './services/GeocodeService';
import { GoogleGeocodeProvider } from './services/GoogleGeocodeProvider';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeocodeCacheEntity]), EventsModule, MemoryModule],
  providers: [
    GeocodeService,
    GeocodeBatchListener,
    GoogleGeocodeProvider,
    {
      provide: GEOCODE_PROVIDER,
      useExisting: GoogleGeocodeProvider,
    },
  ],
  exports: [GeocodeService],
})
export class GeocodeModule {}

export { GeocodeService } from './services/GeocodeService';
export { GeocodeCacheEntity } from './entities/GeocodeCacheEntity';
export { GEOCODE_PROVIDER } from './services/GeocodeProvider';
export type { GeocodeProvider, GeocodeProviderResult } from './services/GeocodeProvider';
export { isVirtualLocation } from './util/virtualLocations';
