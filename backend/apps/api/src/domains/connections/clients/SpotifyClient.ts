import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class SpotifyClient extends BaseOAuth2Client {
  constructor(readonly logger: LoggerService) {
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

  getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
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
