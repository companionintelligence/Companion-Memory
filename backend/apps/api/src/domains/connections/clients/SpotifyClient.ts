import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';
import { ProviderKeyService } from '../services/ProviderKeyService';

import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class SpotifyClient extends BaseOAuth2Client {
  constructor(
    readonly logger: LoggerService,
    private readonly providerKeyService: ProviderKeyService,
  ) {
    super();
    this.logger.setContext(SpotifyClient.name);
  }

  protected readonly baseUrl = 'https://api.spotify.com';

  protected readonly authorizationEndpoint = 'https://accounts.spotify.com/authorize';

  protected readonly tokenEndpoint = 'https://accounts.spotify.com/api/token';

  protected readonly endpointScopeMap = {
    'Recently Played': ['user-read-recently-played'],
    Playlists: ['playlist-read-private', 'playlist-read-collaborative'],
    'Saved Audiobooks': ['user-library-read'],
    'Saved Episodes': ['user-library-read'],
    'Saved Shows': ['user-library-read'],
    'Saved Tracks': ['user-library-read'],
    'Top Artists': ['user-top-read'],
    'Top Tracks': ['user-top-read'],
    default: ['user-read-email', 'user-read-private'],
  };

  protected readonly scopes = [
    'user-read-email',
    'user-read-private',
    'user-read-recently-played',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-library-read',
    'user-top-read',
  ];

  protected readonly extraAuthParams = {
    show_dialog: 'true',
  };

  getClientCredentials(connection: Connection): Promise<{ clientId: string; clientSecret: string }> {
    const clientIdVariable = 'SPOTIFY_CLIENT_ID';
    const clientSecretVariable = 'SPOTIFY_CLIENT_SECRET';
    const clientIdFromEnv = process.env[clientIdVariable];
    const clientSecretFromEnv = process.env[clientSecretVariable];

    return this.providerKeyService
      .findByProviderId({ userId: connection.userId }, connection.id)
      .then((keys) => {
        const clientId = keys ? keys.clientId : clientIdFromEnv;
        const clientSecret = keys ? keys.clientSecret : clientSecretFromEnv;

        if (!clientId) {
          this.logger.error(
            `No custom providerKey for Spotify and expected environment variable ${clientIdVariable} not specified`,
          );

          throw new Error('Client id not configured for provider');
        }

        if (!clientSecret) {
          this.logger.error(
            `No custom providerKey for Spotify and expected environment variable ${clientSecretVariable} not specified`,
          );

          throw new Error('Client secret not configured for provider');
        }

        return { clientId, clientSecret };
      });
  }

  protected getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
    const scopesSet = new Set<string>(this.endpointScopeMap['default']);

    activeEndpoints.forEach((endpoint) => {
      const scopes = this.endpointScopeMap[endpoint as keyof typeof this.endpointScopeMap];
      if (scopes) {
        scopes.forEach((scope) => scopesSet.add(scope));
      }
    });

    return scopesSet.size > 0 ? Array.from(scopesSet).join(' ') : '';
  }

  getAccountIdentifier(connection: Connection): Promise<string> {
    return new Promise((resolve) =>
      this.fetchProfile(connection).then((result) => {
        resolve(result.id || '');
      }),
    );
  }

  /**
   * Get user's basic profile information
   */
  private async fetchProfile(connection: Connection): Promise<{ [key: string]: string }> {
    try {
      return await this.request<{
        id: string;
        display_name: string;
        email?: string;
      }>(connection, `/v1/me`);
    } catch (error) {
      this.logger.error('Failed to fetch Spotify profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
