import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';
import { ProviderKeyService } from '../services/ProviderKeyService';

import { BaseOAuth2Client } from './BaseOAuth2Client';

@Injectable()
export class MicrosoftClient extends BaseOAuth2Client {
  constructor(
    readonly logger: LoggerService,
    private readonly providerKeyService: ProviderKeyService,
  ) {
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

  protected getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
    const scopesSet = new Set<string>(this.endpointScopeMap['default']);

    activeEndpoints.forEach((endpoint) => {
      const scopes = this.endpointScopeMap[endpoint as keyof typeof this.endpointScopeMap];
      scopes.forEach((scope) => scopesSet.add(scope));
    });

    return scopesSet.size > 0 ? Array.from(scopesSet).join(' ') : '';
  }

  getClientCredentials(connection: Connection): Promise<{ clientId: string; clientSecret: string }> {
    const clientIdVariable = 'MICROSOFT_CLIENT_ID';
    const clientSecretVariable = 'MICROSOFT_CLIENT_SECRET';
    const clientIdFromEnv = process.env[clientIdVariable];
    const clientSecretFromEnv = process.env[clientSecretVariable];

    return this.providerKeyService
      .findByProviderId({ userId: connection.userId }, connection.provider!.id)
      .then((keys) => {
        const clientId = keys ? keys.clientId : clientIdFromEnv;
        const clientSecret = keys ? keys.clientSecret : clientSecretFromEnv;

        if (!clientId) {
          this.logger.error(
            `No custom providerKey for Microsoft and expected environment variable ${clientIdVariable} not specified`,
          );

          throw new Error('Client id not configured for provider');
        }

        if (!clientSecret) {
          this.logger.error(
            `No custom providerKey for Microsoft and expected environment variable ${clientSecretVariable} not specified`,
          );

          throw new Error('Client secret not configured for provider');
        }

        return { clientId, clientSecret };
      });
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
