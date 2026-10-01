import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { firstAccountLabel } from './accountLabel';
import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class FacebookClient extends BaseOAuth2Client {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(FacebookClient.name);
  }

  protected readonly baseUrl = 'https://graph.facebook.com';

  protected readonly authorizationEndpoint = 'https://www.facebook.com/v21.0/dialog/oauth';

  protected readonly tokenEndpoint = 'https://graph.facebook.com/v21.0/oauth/access_token';

  protected readonly endpointScopeMap = {
    Posts: ['user_posts'],
    Photos: ['user_photos'],
    Videos: ['user_videos'],
    // Not requested for now: user_likes goes back in when we re-request it
    // from Meta in a later App Review submission, separate from the
    // posts/photos/videos one.
    // Likes: ['user_likes'],
    default: ['email', 'public_profile'],
  };

  // Facebook permissions based on what you configured
  protected readonly scopes = [
    'email',
    'public_profile',
    // 'user_likes', // re-requested later; see endpointScopeMap
    'user_photos',
    'user_posts',
    'user_videos',
  ];

  protected readonly extraAuthParams = {};

  getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
    const scopesSet = new Set<string>(this.endpointScopeMap['default']);

    activeEndpoints.forEach((endpoint) => {
      // `?? []`: a connection made before Friends and Likes were withdrawn
      // still lists them, and reconnecting it must not ask for their scopes.
      const scopes = this.endpointScopeMap[endpoint as keyof typeof this.endpointScopeMap] ?? [];
      scopes.forEach((scope) => scopesSet.add(scope));
    });

    return scopesSet.size > 0 ? Array.from(scopesSet).join(' ') : '';
  }

  getAccountIdentifier(connection: Connection): Promise<string> {
    return new Promise((resolve, reject) =>
      this.fetchProfile(connection)
        .then((result) => {
          resolve(result.id || '');
        })
        .catch((err) => reject(err)),
    );
  }

  async getAccountLabel(connection: Connection): Promise<string | null> {
    const profile = await this.fetchProfile(connection);

    return firstAccountLabel(profile.email);
  }

  /**
   * Get user's basic profile information
   */
  private async fetchProfile(connection: Connection): Promise<{ [key: string]: string }> {
    try {
      const fields = ['id', 'name', 'email'].join(',');

      return await this.request<{
        id: string;
        name: string;
        email?: string;
      }>(connection, `/v21.0/me?fields=${fields}`);
    } catch (error) {
      this.logger.error('Failed to fetch Facebook profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
