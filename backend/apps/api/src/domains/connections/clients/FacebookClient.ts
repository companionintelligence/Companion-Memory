import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';
import { ProviderKeyService } from '../services/ProviderKeyService';

import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class FacebookClient extends BaseOAuth2Client {
  constructor(
    readonly logger: LoggerService,
    private readonly providerKeyService: ProviderKeyService,
  ) {
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
    Friends: ['user_friends'],
    Likes: ['user_likes'],
    default: ['email', 'public_profile'],
  };

  // Facebook permissions based on what you configured
  protected readonly scopes = [
    'email',
    'public_profile',
    'user_friends',
    'user_likes',
    'user_photos',
    'user_posts',
    'user_videos',
  ];

  protected readonly extraAuthParams = {};

  getClientCredentials(connection: Connection): Promise<{ clientId: string; clientSecret: string }> {
    const clientIdVariable = 'FACEBOOK_CLIENT_ID';
    const clientSecretVariable = 'FACEBOOK_CLIENT_SECRET';
    const clientIdFromEnv = process.env[clientIdVariable];
    const clientSecretFromEnv = process.env[clientSecretVariable];

    return this.providerKeyService
      .findByProviderId({ userId: connection.userId }, connection.id)
      .then((keys) => {
        const clientId = keys ? keys.clientId : clientIdFromEnv;
        const clientSecret = keys ? keys.clientSecret : clientSecretFromEnv;

        if (!clientId) {
          this.logger.error(
            `No custom providerKey for Facebook and expected environment variable ${clientIdVariable} not specified`,
          );

          throw new Error('Client id not configured for provider');
        }

        if (!clientSecret) {
          this.logger.error(
            `No custom providerKey for Facebook and expected environment variable ${clientSecretVariable} not specified`,
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
      scopes.forEach((scope) => scopesSet.add(scope));
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
