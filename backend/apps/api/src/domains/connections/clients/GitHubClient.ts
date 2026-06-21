import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class GitHubClient extends BaseOAuth2Client {
  constructor(readonly logger: LoggerService) {
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getScopesFromActiveEndpoints(_activeEndpoints: string[]) {
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
