import config from '@ci/configuration';

import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse } from './types';

export class HomeAssistantClient extends BaseOAuth2Client {
  async getAuthorizationUrl(connection: Connection): Promise<string> {
    if (connection.clientid == null) {
      throw new Error('OAuth credentials not configured');
    }

    const provider = connection.provider;

    if (provider == null) {
      throw new Error('Connection not associated with a provider');
    }

    // Home Assistant requires the tokenHost to be the user's HA instance URL
    // This should be provided as the tokenHost in the connection configuration
    if (provider.tokenHost == null) {
      throw new Error('Home Assistant instance URL not configured. Please set the tokenHost to your Home Assistant URL.');
    }

    const authEndpoint = this.mergeUrls([provider.tokenHost, provider.authorizePath]);

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