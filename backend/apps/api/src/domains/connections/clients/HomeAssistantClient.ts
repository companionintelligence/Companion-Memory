import config from '@ci/configuration';

import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse, TokenExchange, TokenResponse } from './types';

export class HomeAssistantClient extends BaseOAuth2Client {
  async getAuthorizationUrl(connection: Connection): Promise<string> {
    if (connection.clientid == null) {
      throw new Error('OAuth credentials not configured');
    }

    const provider = connection.provider;

    if (provider == null) {
      throw new Error('Connection not associated with a provider');
    }

    // For Home Assistant, the clientkey field stores the Home Assistant instance URL
    // since each HA instance has its own URL
    const homeAssistantUrl = connection.clientkey;
    if (!homeAssistantUrl) {
      throw new Error('Home Assistant instance URL not configured. Please set the Home Assistant URL in the clientkey field.');
    }

    const authEndpoint = this.mergeUrls([homeAssistantUrl, provider.authorizePath]);

    const providerScope = provider.scopes ?? [];
    const resolvedScope = Array.isArray(providerScope) ? providerScope.join(' ') : providerScope;

    const params = new URLSearchParams({
      client_id: connection.clientid,
      redirect_uri: config.auth.oauth.callbackUrl,
      response_type: 'code',
      scope: resolvedScope,
      state: connection.id,
    });

    return `${authEndpoint}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(connection: Connection, code: string): Promise<TokenExchange> {
    if (connection.clientid == null || connection.clientsecret == null) {
      throw new Error('OAuth credentials not configured');
    }

    const provider = connection.provider;

    if (provider == null) {
      throw new Error('Connection not associated with a provider');
    }

    // For Home Assistant, get the URL from clientkey field
    const homeAssistantUrl = connection.clientkey;
    if (!homeAssistantUrl) {
      throw new Error('Home Assistant instance URL not configured. Please set the Home Assistant URL in the clientkey field.');
    }

    const tokenEndpoint = this.mergeUrls([homeAssistantUrl, provider.tokenPath]);

    const tokenParams = new URLSearchParams({
      code,
      client_id: connection.clientid,
      client_secret: connection.clientsecret,
      redirect_uri: config.auth.oauth.callbackUrl,
      grant_type: 'authorization_code',
    });

    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      let errorDetails;

      try {
        errorDetails = await tokenResponse.json();
      } catch {
        errorDetails = await tokenResponse.text();
      }

      this.logger.error('Token exchange failed', {
        status: tokenResponse.status,
        error: errorDetails,
        endpoint: tokenEndpoint,
      });

      throw new Error('Token exchange failed');
    }

    let tokenData: TokenResponse;

    try {
      tokenData = (await tokenResponse.json()) as TokenResponse;
    } catch {
      throw new Error('Invalid token response format');
    }

    const tokenExpiry = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

    return {
      accessToken: tokenData.access_token || null,
      refreshToken: tokenData.refresh_token || null,
      tokenExpiry,
    };
  }

  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    if (connection.accessToken == null) {
      throw new Error('Connection not authenticated');
    }

    // For Home Assistant, use the URL from clientkey field as the base URL
    const homeAssistantUrl = connection.clientkey;
    if (!homeAssistantUrl) {
      throw new Error('Home Assistant instance URL not configured. Please set the Home Assistant URL in the clientkey field.');
    }

    const response = await fetch(`${homeAssistantUrl}${endpoint}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${connection.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data: T = await response.json();

    return data;
  }

  async sync(connection: Connection): Promise<SyncResponse> {
    this.logger.log('Syncing Home Assistant data', { connectionId: connection.id });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];

    // Home Assistant States API - Get all entity states
    try {
      const statesData = await this.request(connection, '/api/states');

      syncResults.push({
        api: 'Home Assistant States',
        data: statesData,
      });
    } catch (error) {
      const errorMsg = `Home Assistant States API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    // Home Assistant Config API - Get basic config info
    try {
      const configData = await this.request(connection, '/api/config');

      syncResults.push({
        api: 'Home Assistant Config',
        data: configData,
      });
    } catch (error) {
      const errorMsg = `Home Assistant Config API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    // Home Assistant Services API - Get available services
    try {
      const servicesData = await this.request(connection, '/api/services');

      syncResults.push({
        api: 'Home Assistant Services',
        data: servicesData,
      });
    } catch (error) {
      const errorMsg = `Home Assistant Services API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    return {
      success: errors.length === 0,
      message: `Sync completed. ${syncResults.length} APIs processed successfully. ${errors.length} errors occurred.`,
      data: {
        results: syncResults,
        errors,
      },
    };
  }
}