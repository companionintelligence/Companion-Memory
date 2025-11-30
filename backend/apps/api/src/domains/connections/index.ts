/**
 * Manages connections to third-party services and providers, such as Google.
 * This module is responsible for storing connection details, handling authentication
 * with external APIs, and orchestrating data synchronization.
 *
 * ### Key Components:
 * - **Providers (`ProviderService`, `ProviderEntity`)**: Manages the types of
 *   third-party services available to connect (e.g., Google, Microsoft).
 * - **Connections (`ConnectionService`, `ConnectionEntity`)**: Manages individual
 *   user connections to providers, including credentials and sync status.
 * - **Clients (`ClientFactory`, `GoogleClient`)**: Provides the implementation for
 *   communicating with external service APIs. The factory pattern is used to
 *   select the appropriate client for a given connection.
 * - **Controllers (`ConnectionsController`, `ProvidersController`)**: Expose REST
 *   API endpoints for managing connections and providers.
 * - **Event Integration**: Interacts with the `EventsModule`, likely to process
 *   data (like calendar events) synced from external services.
 *
 * @module ConnectionsModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { ClientFactory, FacebookClient, GoogleClient, MicrosoftClient } from './clients';
import { ConnectionsController } from './controllers/ConnectionsController';
import { ProvidersController } from './controllers/ProvidersController';
import { ConnectionEntity } from './entities/ConnectionEntity';
import { ProviderEntity } from './entities/ProviderEntity';
import { ConnectionService } from './services/ConnectionService';
import { ProviderService } from './services/ProviderService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([ConnectionEntity, ProviderEntity]), EventsModule],
  providers: [
    ClientFactory,
    FacebookClient,
    GoogleClient,
    ConnectionService,
    ProviderService,
    MicrosoftClient,
  ],
  controllers: [ConnectionsController, ProvidersController],
  exports: [ClientFactory, ConnectionService, ProviderService, FacebookClient, GoogleClient, MicrosoftClient],
})
export class ConnectionsModule {}

// Entities
export { ConnectionEntity, ProviderEntity };

// Services
export { ConnectionService, ProviderService };
export { ClientFactory } from './clients';

// Clients
export { FacebookClient, GoogleClient, MicrosoftClient };

// Types
export type { Connection } from './entities/ConnectionEntity';
export type { Provider } from './entities/ProviderEntity';
export type { SyncResponse } from './clients/types';
