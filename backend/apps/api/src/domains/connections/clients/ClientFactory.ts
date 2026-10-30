import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';

import { BaseClient as Client } from './BaseClient';
import { DropboxClient } from './DropboxClient';
import { FacebookClient } from './FacebookClient';
import { GitHubClient } from './GitHubClient';
import { GoogleClient } from './GoogleClient';
import { MicrosoftClient } from './MicrosoftClient';
import { RedditClient } from './RedditClient';
import { SignalClient } from './SignalClient';
import { SlackClient } from './SlackClient';
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
    private readonly redditClient: RedditClient,
    private readonly spotifyClient: SpotifyClient,
    private readonly signalClient: SignalClient,
    private readonly slackClient: SlackClient,
    private readonly steamClient: SteamClient,
    private readonly dropboxClient: DropboxClient,
  ) {
    this.providers.set(config.auth.providers.google.id, this.googleClient);
    this.providers.set(config.auth.providers.microsoft.id, this.microsoftClient);
    this.providers.set(config.auth.providers.facebook.id, this.facebookClient);
    this.providers.set(config.auth.providers.github.id, this.gitHubClient);
    this.providers.set(config.auth.providers.reddit.id, this.redditClient);
    this.providers.set(config.auth.providers.spotify.id, this.spotifyClient);
    this.providers.set(config.auth.providers.signal.id, this.signalClient);
    this.providers.set(config.auth.providers.slack.id, this.slackClient);
    this.providers.set(config.auth.providers.steam.id, this.steamClient);
    this.providers.set(config.auth.providers.dropbox.id, this.dropboxClient);
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
