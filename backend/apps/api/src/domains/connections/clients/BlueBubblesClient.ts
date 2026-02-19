import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseClient } from './BaseClient';
import type { SyncResponse, TokenExchange } from './types';

interface BlueBubblesConfig {
  serverUrl: string;
  password: string;
}

interface BlueBubblesMessage {
  guid: string;
  text: string;
  dateCreated: number;
  dateRead?: number;
  handleId: string;
  isFromMe: boolean;
  chatGuid?: string;
  associatedMessageGuid?: string;
  threadOriginatorGuid?: string;
}

interface BlueBubblesChat {
  guid: string;
  displayName?: string;
  participants?: Array<{
    address: string;
  }>;
}

@Injectable()
export class BlueBubblesClient extends BaseClient {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(BlueBubblesClient.name);
  }

  /**
   * BlueBubbles doesn't use OAuth, so we don't generate an authorization URL
   */
  async getAuthorizationUrl(): Promise<string> {
    throw new Error('BlueBubbles does not use OAuth authorization');
  }

  /**
   * BlueBubbles doesn't use OAuth authorization codes
   */
  async exchangeAuthorizationCode(): Promise<TokenExchange> {
    throw new Error('BlueBubbles does not use OAuth authorization');
  }

  /**
   * BlueBubbles uses password-based authentication, not refresh tokens
   */
  async refreshAccessToken(connection: Connection): Promise<TokenExchange> {
    // For BlueBubbles, we just return the existing password as the "token"
    // The password is stored in accessToken field
    return {
      accessToken: connection.accessToken,
      refreshToken: null,
      tokenExpiry: null,
    };
  }

  /**
   * Get the server URL and password from the connection's sync state
   */
  private getConfig(connection: Connection): BlueBubblesConfig {
    const syncState = connection.syncState as Record<string, unknown> | null;
    const serverUrl = (syncState?.serverUrl as string) || process.env.BLUEBUBBLES_SERVER_URL;
    const password = connection.accessToken || process.env.BLUEBUBBLES_PASSWORD;

    if (!serverUrl || !password) {
      throw new Error('BlueBubbles server URL and password must be configured');
    }

    return { serverUrl, password };
  }

  /**
   * Make a request to the BlueBubbles REST API
   */
  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    const config = this.getConfig(connection);
    const url = `${config.serverUrl}${endpoint}`;

    this.logger.debug(`Making request to BlueBubbles API: ${endpoint}`);

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.password}`,
      },
    });

    if (!response.ok) {
      let errorMessage = `BlueBubbles API request failed: ${response.statusText}`;

      try {
        const errorData = (await response.json()) as { error?: { message?: string } };
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
        }
      } catch {
        // If we can't parse the error response, use the default message
      }

      this.logger.error(errorMessage, { endpoint, status: response.status });
      throw new Error(errorMessage);
    }

    const data: T = await response.json();

    return data;
  }

  /**
   * Get the account identifier (server info)
   */
  async getAccountIdentifier(connection: Connection): Promise<string> {
    try {
      const serverInfo = await this.request<{ data: { macosVersion?: string } }>(
        connection,
        '/api/v1/server/info',
      );

      return serverInfo.data?.macosVersion || 'bluebubbles-server';
    } catch (error) {
      this.logger.error('Failed to fetch BlueBubbles server info', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Sync messages from BlueBubbles
   */
  async sync(connection: Connection): Promise<SyncResponse[]> {
    const results: SyncResponse[] = [];

    try {
      const syncState = (connection.syncState as Record<string, unknown>) || {};
      const lastSync = (syncState.lastSync as number) || 0;
      const now = Date.now();

      // Fetch messages since last sync
      const messagesResponse = await this.request<{
        data: BlueBubblesMessage[];
      }>(connection, `/api/v1/message/query?after=${lastSync}&limit=100`);

      const messages = messagesResponse.data || [];

      this.logger.debug(`Fetched ${messages.length} messages from BlueBubbles`);

      // Fetch chats to get conversation context
      const chatsResponse = await this.request<{
        data: BlueBubblesChat[];
      }>(connection, '/api/v1/chat');

      const chats = chatsResponse.data || [];

      results.push({
        success: true,
        message: 'Successfully synced messages',
        data: {
          results: [
            {
              api: 'messages',
              data: messages,
              syncState: {
                lastSync: now,
                messageCount: messages.length,
              },
            },
            {
              api: 'chats',
              data: chats,
              syncState: {
                lastSync: now,
                chatCount: chats.length,
              },
            },
          ],
          errors: [],
        },
      });
    } catch (error) {
      this.logger.error('Failed to sync BlueBubbles data', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      results.push({
        success: false,
        message: 'Failed to sync BlueBubbles data',
        data: {
          results: [],
          errors: [error instanceof Error ? error.message : 'Unknown error'],
        },
      });
    }

    return results;
  }
}
