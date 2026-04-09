import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';
import { ProviderKeyService } from '../services/ProviderKeyService';

import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class GitHubClient extends BaseOAuth2Client {
  constructor(
    readonly logger: LoggerService,
    private readonly providerKeyService: ProviderKeyService,
  ) {
    super();
    this.logger.setContext(GitHubClient.name);
  }

  protected readonly baseUrl = 'https://api.github.com';

  protected readonly authorizationEndpoint = 'https://github.com/login/oauth/authorize';

  protected readonly tokenEndpoint = 'https://github.com/login/oauth/access_token';

  protected readonly endpointScopeMap = {
    default: [] as string[],
  };

  protected readonly scopes: string[] = [];

  protected readonly extraAuthParams = {};

  getClientCredentials(connection: Connection): Promise<{ clientId: string; clientSecret: string }> {
    const clientIdVariable = 'GITHUB_CLIENT_ID';
    const clientSecretVariable = 'GITHUB_CLIENT_SECRET';
    const clientIdFromEnv = process.env[clientIdVariable];
    const clientSecretFromEnv = process.env[clientSecretVariable];

    return this.providerKeyService
      .findByProviderId({ userId: connection.userId }, connection.id)
      .then((keys) => {
        const clientId = keys ? keys.clientId : clientIdFromEnv;
        const clientSecret = keys ? keys.clientSecret : clientSecretFromEnv;

        if (!clientId) {
          this.logger.error(
            `No custom providerKey for GitHub and expected environment variable ${clientIdVariable} not specified`,
          );

          throw new Error('Client id not configured for provider');
        }

        if (!clientSecret) {
          this.logger.error(
            `No custom providerKey for GitHub and expected environment variable ${clientSecretVariable} not specified`,
          );

          throw new Error('Client secret not configured for provider');
        }

        return { clientId, clientSecret };
      });
  }

  protected getScopesFromActiveEndpoints(_activeEndpoints: string[]) {
    // GitHub App permissions are defined on the app itself, not via scopes
    return '';
  }

  getAccountIdentifier(connection: Connection) {
    return this.fetchUser(connection).then((result) => result.login);
  }

  /**
   * Get user's basic profile information from GitHub
   */
  private async fetchUser(connection: Connection) {
    try {
      return await this.request<{
        id: number;
        login: string;
        name?: string;
        email?: string;
      }>(connection, `/user`);
    } catch (error) {
      this.logger.error('Failed to fetch GitHub user profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}


