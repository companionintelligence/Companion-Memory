import type { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';
import type { CallbackRequestOrigin } from '../utils/callbackUrls';

import type { TokenExchange } from './types';

export abstract class BaseClient {
  abstract readonly logger: LoggerService;

  /**
   * Where to send the person to approve the connection. `request` is the one that asked, so that an
   * install with no callback address configured returns them to the address their browser used
   * (`utils/callbackUrls.ts`).
   */
  abstract getAuthorizationUrl(connection: Connection, request?: CallbackRequestOrigin): Promise<string>;

  /**
   * The `redirect_uri` sent with the code is the one the authorization was sent with when the
   * connection keeps it, else worked out for `request`, the callback page's.
   */
  abstract exchangeAuthorizationCode(
    connection: Connection,
    code: string,
    request?: CallbackRequestOrigin,
  ): Promise<TokenExchange>;

  abstract refreshAccessToken(connection: Connection): Promise<TokenExchange>;

  abstract request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T>;

  abstract requestRaw(connection: Connection, endpoint: string, options?: RequestInit): Promise<Response>;

  abstract getAccountIdentifier(connection: Connection): Promise<string>;

  /**
   * Human-readable account identity for the UI (email, login, phone).
   * Distinct from {@link getAccountIdentifier}, which is the stable provider id.
   */
  getAccountLabel(connection: Connection): Promise<string | null> {
    void connection;

    return Promise.resolve(null);
  }

  /**
   * The OAuth scopes this provider requests. Returns `null` for providers that
   * don't use scopes (e.g. OpenID providers like Steam).
   */
  getScopes(): string[] | null {
    return null;
  }
}
