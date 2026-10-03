import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { firstAccountLabel } from './accountLabel';
import { BaseOAuth2Client } from './BaseOAuth2Client';

/** Azure secret IDs are UUIDs; the secret *value* is a long opaque string. */
const AZURE_SECRET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trimOAuthCredential(value: string | undefined | null): string | null {
  const trimmed = value?.trim();

  return trimmed || null;
}

function assertMicrosoftClientSecretLooksValid(clientSecret: string): void {
  if (!AZURE_SECRET_ID_PATTERN.test(clientSecret)) {
    return;
  }

  throw new Error(
    'Microsoft client secret looks like an Azure secret ID (UUID), not the secret value. ' +
      'In Azure Portal → App registrations → Certificates & secrets, create or copy the Value column ' +
      '(shown only once when the secret is created), not the Secret ID.',
  );
}

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

  async getClientCredentials(
    connection: Pick<Connection, 'userId' | 'provider'>,
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    const clientIdVariable = 'MICROSOFT_CLIENT_ID';
    const clientSecretVariable = 'MICROSOFT_CLIENT_SECRET';
    const clientIdFromEnv = process.env[clientIdVariable];
    const clientSecretFromEnv = process.env[clientSecretVariable];
    const keys = await super.getClientCredentials(connection);
    const clientId = trimOAuthCredential(keys?.clientId ?? clientIdFromEnv ?? null);
    const clientSecret = trimOAuthCredential(keys?.clientSecret ?? clientSecretFromEnv ?? null);

    if (!clientId && !clientSecret) {
      return null;
    }

    if (clientSecret) {
      assertMicrosoftClientSecretLooksValid(clientSecret);
    }

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

    return firstAccountLabel(profile.mail, profile.userPrincipalName);
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
