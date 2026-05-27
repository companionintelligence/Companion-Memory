import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';

import { BaseClient as Client } from './BaseClient';
import { FacebookClient } from './FacebookClient';
import { GitHubClient } from './GitHubClient';
import { GoogleClient } from './GoogleClient';
import { MicrosoftClient } from './MicrosoftClient';
import { SpotifyClient } from './SpotifyClient';
import { SteamClient } from './SteamClient';

@Injectable()
export class ClientFactory {
  private readonly providers = new Map<string, Client>();

  constructor(
    private readonly googleClient: GoogleClient,
    private readonly microsoftClient: MicrosoftClient,
    private readonly facebookClient: FacebookClient,
    private readonly gitHubClient: GitHubClient,
    private readonly spotifyClient: SpotifyClient,
    private readonly steamClient: SteamClient,
  ) {
    this.providers.set(config.auth.providers.google.id, this.googleClient);
    this.providers.set(config.auth.providers.microsoft.id, this.microsoftClient);
    this.providers.set(config.auth.providers.facebook.id, this.facebookClient);
    this.providers.set(config.auth.providers.github.id, this.gitHubClient);
    this.providers.set(config.auth.providers.spotify.id, this.spotifyClient);
    this.providers.set(config.auth.providers.steam.id, this.steamClient);
  }

  getClientByProviderId(providerId: string | null | undefined): Client {
    if (providerId == null) {
      throw new Error('API client requested for a null Provider');
    }

    const provider = this.providers.get(providerId);

    if (provider == null) {
      throw new Error(`Unsupported Provider id: ${providerId}`);
    }

    return provider;
  }
}
