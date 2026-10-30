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

import { ApplianceAdminGuard } from '@ci/common/guards';
import { EventsModule } from '@ci/domains/events';

import {
  ClientFactory,
  FacebookClient,
  GitHubClient,
  DropboxClient,
  RedditClient,
  GoogleClient,
  MicrosoftClient,
  SpotifyClient,
  SignalClient,
  SlackClient,
  SteamClient,
} from './clients';
import { ConnectionsController } from './controllers/ConnectionsController';
import { ProvidersController } from './controllers/ProvidersController';
import { ConnectionEntity } from './entities/ConnectionEntity';
import { ProviderEntity } from './entities/ProviderEntity';
import { ProviderKeyEntity } from './entities/ProviderKeyEntity';
import { CloudOAuthProxyService } from './services/CloudOAuthProxyService';
import { ConnectionService } from './services/ConnectionService';
import { ProviderKeyService } from './services/ProviderKeyService';
import { ProviderService } from './services/ProviderService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([ConnectionEntity, ProviderEntity, ProviderKeyEntity]), EventsModule],
  providers: [
    ClientFactory,
    FacebookClient,
    GitHubClient,
    DropboxClient,
    RedditClient,
    GoogleClient,
    CloudOAuthProxyService,
    ConnectionService,
    ProviderService,
    ProviderKeyService,
    MicrosoftClient,
    SpotifyClient,
    SignalClient,
    SlackClient,
    SteamClient,
    // Registered so Nest resolves its DataSource here: connecting Signal asks it whether the
    // caller is an administrator (the route serves every provider, so it cannot be a guard).
    ApplianceAdminGuard,
  ],
  controllers: [ConnectionsController, ProvidersController],
  exports: [
    ClientFactory,
    CloudOAuthProxyService,
    ConnectionService,
    ProviderService,
    ProviderKeyService,
    FacebookClient,
    GitHubClient,
    DropboxClient,
    RedditClient,
    GoogleClient,
    MicrosoftClient,
    SpotifyClient,
    SignalClient,
    SlackClient,
    SteamClient,
  ],
})
export class ConnectionsModule {}

// Entities
export { ConnectionEntity, ProviderEntity, ProviderKeyEntity };

// Services
export { ConnectionService, ProviderService, ProviderKeyService, CloudOAuthProxyService };
export type { PortalDeviceApplication } from './services/CloudOAuthProxyService';
export { ClientFactory } from './clients';

// Clients
export {
  FacebookClient,
  GitHubClient,
  DropboxClient,
  RedditClient,
  GoogleClient,
  MicrosoftClient,
  SpotifyClient,
  SignalClient,
  SlackClient,
  SteamClient,
};

// Types
export type { BaseClient } from './clients/BaseClient';
// BaseOAuth2Client is exported as a VALUE (not just a type) so consumers can do
// `instanceof BaseOAuth2Client` to detect OAuth2 (vs OpenID) providers — used by
// the privacy domain's token-revocation path.
export { BaseOAuth2Client } from './clients/BaseOAuth2Client';
export type { Connection } from './entities/ConnectionEntity';
export type { Provider } from './entities/ProviderEntity';
export type { ProviderKey } from './entities/ProviderKeyEntity';
export type {
  Calendar,
  CalendarEvent,
  CalendarViewWindow,
  OneDrivePageEntity,
  OneDriveFileEntity,
  OutlookMailMessageEntity,
  OutlookAttachment,
  FacebookFriend,
  FacebookLike,
  FacebookPhoto,
  FacebookPost,
  FacebookPostAttachment,
  FacebookVideo,
  GmailMessage,
  GmailPart,
  EmailParticipant,
} from './clients/types';

export { OUTLOOK_SKIP_REGEX, ONEDRIVE_ETAG_REGEX } from './clients/constants';
