import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class MicrosoftClient extends BaseOAuth2Client {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(MicrosoftClient.name);
  }

  protected readonly baseUrl = 'https://graph.microsoft.com';

  protected readonly authorizationEndpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

  protected readonly tokenEndpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

  protected readonly scopes = ['user.read', 'mail.read', 'calendars.read', 'files.read', 'offline_access'];

  protected readonly extraAuthParams = {};

  protected readonly endpointScopeMap = {
    'Outlook Mail': ['mail.read'],
    Calendar: ['calendars.read'],
    OneDrive: ['files.read'],
    default: ['offline_access', 'user.read'],
  };

  getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
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
        console.log('Microsoft profile', result);
        resolve(result.id || '');
      }),
    );
  }

  /**
   * Get user's basic profile information
   */
  private async fetchProfile(connection: Connection): Promise<{ [key: string]: string }> {
    try {
      const endpoint = `/v1.0/me`;

      return (await this.request(connection, endpoint)) as Record<string, string>;
    } catch (error) {
      this.logger.error('Failed to fetch Facebook profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
