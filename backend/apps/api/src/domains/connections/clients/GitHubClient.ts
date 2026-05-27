import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseOAuth2Client } from './BaseOAuth2Client';

interface GitHubProfile {
  id: number;
  login: string;
}

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
    'Repository Events': ['repo'],
    default: ['read:user'],
  };

  protected readonly scopes = ['read:user', 'repo'];

  protected readonly extraAuthParams = {};

  getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
    const scopesSet = new Set<string>(this.endpointScopeMap.default);

    activeEndpoints.forEach((endpoint) => {
      const scopes = this.endpointScopeMap[endpoint as keyof typeof this.endpointScopeMap];

      if (scopes) {
        scopes.forEach((scope) => scopesSet.add(scope));
      }
    });

    return scopesSet.size > 0 ? Array.from(scopesSet).join(' ') : '';
  }

  request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    return super.request<T>(connection, endpoint, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...options?.headers,
      },
    });
  }

  getAccountIdentifier(connection: Connection): Promise<string> {
    return new Promise((resolve) =>
      this.fetchProfile(connection).then((result) => {
        resolve(String(result.id ?? result.login ?? ''));
      }),
    );
  }

  private async fetchProfile(connection: Connection): Promise<GitHubProfile> {
    try {
      return await this.request<GitHubProfile>(connection, '/user');
    } catch (error) {
      this.logger.error('Failed to fetch GitHub profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
