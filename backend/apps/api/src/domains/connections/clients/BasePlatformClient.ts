import type { Connection } from '../types';

import { BaseClient } from './BaseClient';
import type { SyncResponse, TokenExchange } from './types';

export abstract class BasePlatformClient extends BaseClient {
  async getAuthorizationUrl(_connection: Connection): Promise<string> {
    throw new Error('Platform connections do not support web-based OAuth authorization');
  }

  async exchangeAuthorizationCode(_connection: Connection, _code: string): Promise<TokenExchange> {
    throw new Error('Platform connections do not support OAuth token exchange');
  }

  async request<T>(_connection: Connection, _endpoint: string, _options?: RequestInit): Promise<T> {
    throw new Error('Platform connections do not support direct HTTP requests');
  }

  abstract getConnectionInstructions(): string;
}