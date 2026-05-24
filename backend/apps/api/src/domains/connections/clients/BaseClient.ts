import type { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import type { TokenExchange } from './types';

export abstract class BaseClient {
  abstract readonly logger: LoggerService;

  abstract getAuthorizationUrl(connection: Connection): Promise<string>;

  abstract exchangeAuthorizationCode(connection: Connection, code: string): Promise<TokenExchange>;

  abstract refreshAccessToken(connection: Connection): Promise<TokenExchange>;

  abstract request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T>;

  abstract getAccountIdentifier(connection: Connection): Promise<string>;
}
