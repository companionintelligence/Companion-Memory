import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class GoogleClient extends BaseOAuth2Client {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(GoogleClient.name);
  }

  protected readonly baseUrl = 'https://www.googleapis.com';

  protected readonly authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';

  protected readonly tokenEndpoint = 'https://oauth2.googleapis.com/token';

  protected readonly endpointScopeMap = {
    Calendar: ['calendar.readonly'],
    Gmail: ['gmail.readonly'],
    Drive: ['drive.readonly'],
    'YouTube Activities': ['youtube.readonly'],
    'YouTube Likes': ['youtube.readonly'],
    'YouTube Playlists': ['youtube.readonly'],
    'YouTube Subscriptions': ['youtube.readonly'],
    Contacts: ['contacts.readonly'],
    default: ['userinfo.profile'],
  };

  protected readonly scopeNames = [
    'gmail.readonly',
    'calendar.readonly',
    'drive.readonly',
    'youtube.readonly',
    'contacts.readonly',
  ];

  protected readonly scopes = this.scopeNames.map((scope) => `https://www.googleapis.com/auth/${scope}`);

  //prompt: consent seems to be needed to always get refresh tokens
  protected readonly extraAuthParams = {
    access_type: 'offline',
    prompt: 'consent',
  };

  getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
    const scopesSet = new Set<string>(
      this.endpointScopeMap['default'].map((scope) => `https://www.googleapis.com/auth/${scope}`),
    );

    activeEndpoints.forEach((endpoint) => {
      const scopes = this.endpointScopeMap[endpoint as keyof typeof this.endpointScopeMap] || [];
      scopes.forEach((scope) => scopesSet.add(`https://www.googleapis.com/auth/${scope}`));
    });

    return scopesSet.size > 0 ? Array.from(scopesSet).join(' ') : '';
  }

  getAccountIdentifier(connection: Connection): Promise<string> {
    return new Promise((resolve) =>
      this.fetchProfile(connection).then((result) => {
        console.log('Google profile', result);
        resolve(result.id || '');
      }),
    );
  }

  /**
   * Get user's basic profile information
   */
  private async fetchProfile(connection: Connection): Promise<{ [key: string]: string }> {
    try {
      const endpoint = `/oauth2/v1/userinfo?alt=json`;

      return (await this.request(connection, endpoint)) as Record<string, string>;
    } catch (error) {
      this.logger.error('Failed to fetch Google profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {};
    }
  }
}
