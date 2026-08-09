/**
 * The geocode domain resolves free-text location names into PostGIS coordinates
 * and coordinates back into readable place names (geodata-plan Phase 1).
 *
 * ### Key components
 * - **GeocodeService**: cache-aware orchestration — canonicalizes the query,
 *   checks ci.geocode_cache, calls the provider on a miss, branches on the
 *   provider `status` (NOT HTTP code), writes the (possibly negative) cache row,
 *   and returns a PostGIS-ready Point with a precision-derived confidence.
 * - **PortalGeocodeProvider**: the default. All egress goes through CI-Portal,
 *   which holds the provider key and fronts a cache shared by every appliance —
 *   the appliance's own cache kills repeats within one user, Portal's kills them
 *   across all users.
 * - **GoogleGeocodeProvider**: direct-key fallback for deployments with no
 *   Portal reachability.
 * - **GeocodeBatchListener**: PGBoss `@OnEvent` worker for
 *   {@link GeocodeBatchRequestEvent}; concurrency-capped backfill that writes
 *   coordinates + confidence back onto events.
 *
 * Exactly one provider is bound to the {@link GEOCODE_PROVIDER} token, chosen by
 * `config.geocoding.provider`, so the orchestration stays provider-agnostic.
 *
 * @module GeocodeModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import config from '@ci/configuration';
import { EventsModule } from '@ci/domains/events';
import { MemoryModule } from '@ci/domains/memory';

import { GeocodeCacheEntity } from './entities/GeocodeCacheEntity';
import { GeocodeBatchListener } from './listeners/GeocodeBatchListener';
import { GEOCODE_PROVIDER } from './services/GeocodeProvider';
import { GeocodeService } from './services/GeocodeService';
import { GoogleGeocodeProvider } from './services/GoogleGeocodeProvider';
import { PortalGeocodeProvider } from './services/PortalGeocodeProvider';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeocodeCacheEntity]), EventsModule, MemoryModule],
  providers: [
    GeocodeService,
    GeocodeBatchListener,
    // Both are registered so either can be selected without a module rebuild;
    // only the one bound below is ever asked for a lookup, and constructing the
    // other costs nothing (both only read config in their constructor).
    GoogleGeocodeProvider,
    PortalGeocodeProvider,
    {
      provide: GEOCODE_PROVIDER,
      // Portal by default: the appliance must not hold a provider key or call
      // Google directly. `google` stays reachable via GEOCODING_PROVIDER for a
      // box that cannot reach Portal.
      useExisting: config.geocoding.provider === 'google' ? GoogleGeocodeProvider : PortalGeocodeProvider,
    },
  ],
  exports: [GeocodeService],
})
export class GeocodeModule {}

export { GeocodeService } from './services/GeocodeService';
export { GeocodeCacheEntity } from './entities/GeocodeCacheEntity';
export { GEOCODE_PROVIDER } from './services/GeocodeProvider';
export type { GeocodePoint, GeocodeProvider, GeocodeProviderResult } from './services/GeocodeProvider';
export { PortalGeocodeProvider } from './services/PortalGeocodeProvider';
export { isVirtualLocation } from './util/virtualLocations';
