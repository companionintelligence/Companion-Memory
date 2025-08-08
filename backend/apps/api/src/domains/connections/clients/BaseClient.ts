import { LoggerService } from '@ci/common/services';

import type { Connection } from '../types';

import type { SyncResponse, TokenExchange } from './types';

export abstract class BaseClient {
  protected logger: LoggerService;

  constructor() {
    this.logger = new LoggerService(this.constructor.name);
  }

  abstract getAuthorizationUrl(connection: Connection): Promise<string>;

  abstract exchangeAuthorizationCode(connection: Connection, code: string): Promise<TokenExchange>;

  abstract request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T>;

  abstract sync(connection: Connection): Promise<SyncResponse>;
}
