import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseClient } from './BaseClient';
import type { TokenExchange } from './types';

@Injectable()
export class SignalClient extends BaseClient {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(SignalClient.name);
  }

  get restUrl(): string {
    return config.signalCli.restUrl.replace(/\/$/, '');
  }

  /** The numbers the signal-cli REST service holds, as it lists them (E.164, e.g. `+15551234567`). */
  async listAccounts(apiKey: string): Promise<string[]> {
    const response = await fetch(`${this.restUrl}/v1/accounts`, {
      headers: this.buildHeaders(apiKey),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Failed to validate Signal API key: ${response.status} ${errorText}`);
    }

    const accounts = (await response.json()) as unknown;

    return Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === 'string') : [];
  }

  /**
   * The account the caller asked for, as the service spells it, or null when the service does not
   * hold it.
   *
   * Never "the first account it lists". signal-cli can hold several numbers, each somebody's own,
   * and the appliance-wide service answers whoever calls it: picking one for the caller bound
   * their connection to a number nobody checked was theirs. Spacing and punctuation in what the
   * caller typed are ignored; the digits and the leading `+` must match.
   */
  async findAccount(apiKey: string, requested: string): Promise<string | null> {
    const wanted = normalizeNumber(requested);
    const accounts = await this.listAccounts(apiKey);

    return accounts.find((account) => normalizeNumber(account) === wanted) ?? null;
  }

  getAuthorizationUrl(): Promise<string> {
    return Promise.reject(new Error('Signal uses API key authentication'));
  }

  exchangeAuthorizationCode(): Promise<TokenExchange> {
    return Promise.reject(new Error('Signal uses API key authentication'));
  }

  async refreshAccessToken(connection: Connection): Promise<TokenExchange> {
    return {
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      tokenExpiry: connection.tokenExpiry,
    };
  }

  /**
   * The number this connection was made for. A connection without one is refused rather than
   * bound to whichever number the service lists first; see {@link findAccount}.
   */
  getAccountIdentifier(connection: Connection): Promise<string> {
    if (connection.externalId) {
      return Promise.resolve(connection.externalId);
    }

    return Promise.reject(new Error('Signal connection has no number; connect Signal again and name it'));
  }

  async requestRaw(connection: Connection, endpoint: string, options?: RequestInit): Promise<Response> {
    if (!connection.accessToken) {
      throw new Error('Signal connection missing API key');
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.restUrl}${endpoint}`;

    return fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        ...this.buildHeaders(connection.accessToken),
      },
    });
  }

  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    const response = await this.requestRaw(connection, endpoint, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Signal API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return (await response.json()) as T;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
  }
}

/** `+1 (555) 123-4567` and `+15551234567` are the same number. */
function normalizeNumber(value: string): string {
  return value.replace(/[\s().-]/g, '');
}
