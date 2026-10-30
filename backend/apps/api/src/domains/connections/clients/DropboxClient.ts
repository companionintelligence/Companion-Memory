import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { firstAccountLabel } from './accountLabel';
import { BaseOAuth2Client } from './BaseOAuth2Client';

/** Dropbox serves file BYTES from a different host than its JSON API. */
const CONTENT_BASE_URL = 'https://content.dropboxapi.com';

interface DropboxAccount {
  account_id?: string;
  email?: string;
  name?: { display_name?: string };
}

@Injectable()
export class DropboxClient extends BaseOAuth2Client {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(DropboxClient.name);
  }

  protected readonly baseUrl = 'https://api.dropboxapi.com';

  protected readonly authorizationEndpoint = 'https://www.dropbox.com/oauth2/authorize';

  protected readonly tokenEndpoint = 'https://api.dropboxapi.com/oauth2/token';

  // Read-only, and all three must also be ticked on the Dropbox app's
  // Permissions tab: a scope the app itself does not hold is refused at the
  // authorize step.
  protected readonly endpointScopeMap = {
    Files: ['files.metadata.read', 'files.content.read'],
    default: ['account_info.read'],
  };

  protected readonly scopes = ['account_info.read', 'files.metadata.read', 'files.content.read'];

  // Without this Dropbox issues only a four-hour access token and no refresh
  // token, and the connection would need re-authorizing several times a day.
  protected readonly extraAuthParams = {
    token_access_type: 'offline',
  };

  getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
    const scopesSet = new Set<string>(this.endpointScopeMap['default']);

    activeEndpoints.forEach((endpoint) => {
      const scopes = this.endpointScopeMap[endpoint as keyof typeof this.endpointScopeMap];
      if (scopes) {
        scopes.forEach((scope) => scopesSet.add(scope));
      }
    });

    return scopesSet.size > 0 ? Array.from(scopesSet).join(' ') : '';
  }

  /**
   * Call one of Dropbox's RPC endpoints (`/2/files/list_folder`, …). They are
   * all POSTs taking their arguments as a JSON body — including "no
   * arguments", which Dropbox wants spelled as the JSON literal `null`.
   *
   * Dropbox reports errors as `{ error_summary, error: { ".tag": … } }`, not
   * the `{ error: { message } }` shape the base `request` reads, so a failure
   * there would surface as a bare status text. The summary is what says WHY
   * (`path/not_found/`, `reset/` for an expired cursor), so it is put in the
   * message and callers match on it.
   */
  async rpc<T>(connection: Connection, path: string, args: Record<string, unknown> | null): Promise<T> {
    const response = await this.requestRaw(connection, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let summary = body.slice(0, 300);

      try {
        summary = (JSON.parse(body) as { error_summary?: string }).error_summary ?? summary;
      } catch {
        // Not JSON (Dropbox answers some 400s in plain text) — keep the text.
      }

      throw new Error(`Dropbox API request failed: ${response.status} ${summary}`.trim());
    }

    return (await response.json()) as T;
  }

  /**
   * A file's bytes — all of them, or one byte range (answered 206). `fileId`
   * is the `id:…` from a listing, which Dropbox accepts wherever it takes a
   * path and which, unlike a path, is plain ASCII: the argument travels in an
   * HTTP header, where a non-ASCII filename would have to be escaped.
   */
  async download(
    connection: Connection,
    fileId: string,
    range?: { offset: number; length: number },
  ): Promise<Response> {
    return this.requestRaw(connection, `${CONTENT_BASE_URL}/2/files/download`, {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': JSON.stringify({ path: fileId }),
        ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}),
      },
    });
  }

  async getAccountIdentifier(connection: Connection): Promise<string> {
    return (await this.fetchAccount(connection)).account_id || '';
  }

  async getAccountLabel(connection: Connection): Promise<string | null> {
    const account = await this.fetchAccount(connection);

    return firstAccountLabel(account.email, account.name?.display_name);
  }

  /**
   * Dropbox's revocation is not RFC 7009: there is no `token=` form post.
   * `/2/auth/token/revoke` takes no arguments and disables the access token it
   * is CALLED with — and with it the refresh token of the same grant. So this
   * needs a live access token; one that has already expired cannot revoke
   * itself, and the answer is then `{ revoked: false }`, leaving the local
   * delete (and Dropbox's own "Connected apps" page) as what ends access.
   *
   * Best-effort by the base contract: never throws.
   */
  readonly revokesWithAccessToken = true;

  async revoke(connection: Connection): Promise<{ revoked: boolean }> {
    if (!connection.accessToken) {
      return { revoked: false };
    }

    try {
      await this.rpc(connection, '/2/auth/token/revoke', null);

      return { revoked: true };
    } catch (error) {
      this.logger.log('Dropbox token revocation was not accepted; treating as best-effort', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return { revoked: false };
    }
  }

  private async fetchAccount(connection: Connection): Promise<DropboxAccount> {
    try {
      return await this.rpc<DropboxAccount>(connection, '/2/users/get_current_account', null);
    } catch (error) {
      this.logger.error('Failed to fetch Dropbox account', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
