import config from '@ci/configuration';

import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse, TokenExchange, TokenResponse } from './types';
import type {
  HomeAssistantState,
  HomeAssistantConfig,
  HomeAssistantService,
  PersonState,
  DeviceTrackerState,
  ZoneState,
  MediaPlayerState,
  LightState,
  LightControlParams,
  CameraState,
  AutomationState,
  SceneState,
  ServiceCallParams,
  ServiceCallResponse,
  NotificationParams,
  ConversationProcessParams,
  ConversationResponse,
  HomeAssistantSyncStatus,
} from './types/home-assistant';

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
      const statesData = await this.request<HomeAssistantState[]>(connection, '/api/states');

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
      const configData = await this.request<HomeAssistantConfig>(connection, '/api/config');

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
      const servicesData = await this.request<HomeAssistantService[]>(connection, '/api/services');

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

  // Location Tracking Methods
  async getPersonStates(connection: Connection): Promise<PersonState[]> {
    const states = await this.request<HomeAssistantState[]>(connection, '/api/states');
    return states.filter(state => state.entity_id.startsWith('person.')) as PersonState[];
  }

  async getDeviceTrackerStates(connection: Connection): Promise<DeviceTrackerState[]> {
    const states = await this.request<HomeAssistantState[]>(connection, '/api/states');
    return states.filter(state => state.entity_id.startsWith('device_tracker.')) as DeviceTrackerState[];
  }

  async getZoneStates(connection: Connection): Promise<ZoneState[]> {
    const states = await this.request<HomeAssistantState[]>(connection, '/api/states');
    return states.filter(state => state.entity_id.startsWith('zone.')) as ZoneState[];
  }

  async getPersonLocation(connection: Connection, personId: string): Promise<PersonState> {
    return this.request<PersonState>(connection, `/api/states/person.${personId}`);
  }

  // Media Player Methods
  async getMediaPlayerStates(connection: Connection): Promise<MediaPlayerState[]> {
    const states = await this.request<HomeAssistantState[]>(connection, '/api/states');
    return states.filter(state => state.entity_id.startsWith('media_player.')) as MediaPlayerState[];
  }

  async getActiveMediaPlayers(connection: Connection): Promise<MediaPlayerState[]> {
    const mediaPlayers = await this.getMediaPlayerStates(connection);
    return mediaPlayers.filter(player => 
      ['playing', 'paused', 'buffering', 'on'].includes(player.state)
    );
  }

  async getCurrentlyPlaying(connection: Connection): Promise<MediaPlayerState[]> {
    const mediaPlayers = await this.getMediaPlayerStates(connection);
    return mediaPlayers.filter(player => player.state === 'playing');
  }

  async controlMediaPlayer(
    connection: Connection, 
    entityId: string, 
    action: 'play' | 'pause' | 'stop' | 'next_track' | 'previous_track' | 'volume_up' | 'volume_down' | 'volume_mute' | 'volume_set',
    volume?: number
  ): Promise<ServiceCallResponse> {
    const serviceData: Record<string, any> = { entity_id: entityId };
    
    if (action === 'volume_set' && volume !== undefined) {
      serviceData.volume_level = volume / 100; // Home Assistant uses 0-1 range
    }

    return this.callService(connection, {
      domain: 'media_player',
      service: action === 'volume_set' ? 'volume_set' : action,
      service_data: serviceData,
    });
  }

  // Light Control Methods
  async getLightStates(connection: Connection): Promise<LightState[]> {
    const states = await this.request<HomeAssistantState[]>(connection, '/api/states');
    return states.filter(state => state.entity_id.startsWith('light.')) as LightState[];
  }

  async turnOnLight(connection: Connection, params: LightControlParams): Promise<ServiceCallResponse> {
    return this.callService(connection, {
      domain: 'light',
      service: 'turn_on',
      service_data: params,
    });
  }

  async turnOffLight(connection: Connection, entityId: string | string[]): Promise<ServiceCallResponse> {
    return this.callService(connection, {
      domain: 'light',
      service: 'turn_off',
      service_data: { entity_id: entityId },
    });
  }

  async toggleLight(connection: Connection, entityId: string | string[]): Promise<ServiceCallResponse> {
    return this.callService(connection, {
      domain: 'light',
      service: 'toggle',
      service_data: { entity_id: entityId },
    });
  }

  async setBrightness(connection: Connection, entityId: string | string[], brightness: number): Promise<ServiceCallResponse> {
    return this.turnOnLight(connection, {
      entity_id: entityId,
      brightness: Math.min(255, Math.max(0, brightness)),
    });
  }

  async setColor(connection: Connection, entityId: string | string[], color: { r: number; g: number; b: number }): Promise<ServiceCallResponse> {
    return this.turnOnLight(connection, {
      entity_id: entityId,
      rgb_color: [color.r, color.g, color.b],
    });
  }

  // Camera Methods
  async getCameraStates(connection: Connection): Promise<CameraState[]> {
    const states = await this.request<HomeAssistantState[]>(connection, '/api/states');
    return states.filter(state => state.entity_id.startsWith('camera.')) as CameraState[];
  }

  async getCameraImage(connection: Connection, entityId: string): Promise<Buffer> {
    const homeAssistantUrl = connection.clientkey;
    if (!homeAssistantUrl) {
      throw new Error('Home Assistant instance URL not configured');
    }

    const response = await fetch(`${homeAssistantUrl}/api/camera_proxy/${entityId}`, {
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get camera image: ${response.statusText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async takeCameraSnapshot(connection: Connection, entityId: string, filename?: string): Promise<ServiceCallResponse> {
    const serviceData: Record<string, any> = { entity_id: entityId };
    if (filename) {
      serviceData.filename = filename;
    }

    return this.callService(connection, {
      domain: 'camera',
      service: 'snapshot',
      service_data: serviceData,
    });
  }

  // Automation and Scene Methods
  async getAutomationStates(connection: Connection): Promise<AutomationState[]> {
    const states = await this.request<HomeAssistantState[]>(connection, '/api/states');
    return states.filter(state => state.entity_id.startsWith('automation.')) as AutomationState[];
  }

  async getSceneStates(connection: Connection): Promise<SceneState[]> {
    const states = await this.request<HomeAssistantState[]>(connection, '/api/states');
    return states.filter(state => state.entity_id.startsWith('scene.')) as SceneState[];
  }

  async triggerAutomation(connection: Connection, entityId: string): Promise<ServiceCallResponse> {
    return this.callService(connection, {
      domain: 'automation',
      service: 'trigger',
      service_data: { entity_id: entityId },
    });
  }

  async activateScene(connection: Connection, entityId: string): Promise<ServiceCallResponse> {
    return this.callService(connection, {
      domain: 'scene',
      service: 'turn_on',
      service_data: { entity_id: entityId },
    });
  }

  // Notification Methods
  async sendNotification(connection: Connection, params: NotificationParams): Promise<ServiceCallResponse> {
    const service = params.target ? `notify.${params.target}` : 'notify.notify';
    
    return this.callService(connection, {
      domain: 'notify',
      service: service.split('.')[1],
      service_data: {
        message: params.message,
        title: params.title,
        data: params.data,
      },
    });
  }

  async sendTTSAnnouncement(
    connection: Connection, 
    message: string, 
    entityId: string,
    options?: { language?: string; cache?: boolean }
  ): Promise<ServiceCallResponse> {
    return this.callService(connection, {
      domain: 'tts',
      service: 'speak',
      service_data: {
        entity_id: entityId,
        message: message,
        language: options?.language || 'en',
        cache: options?.cache !== false,
      },
    });
  }

  // Voice Command Methods
  async processConversation(connection: Connection, params: ConversationProcessParams): Promise<ConversationResponse> {
    return this.request<ConversationResponse>(connection, '/api/conversation/process', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
  }

  // Generic Service Call Method
  async callService(connection: Connection, params: ServiceCallParams): Promise<ServiceCallResponse> {
    const { domain, service, service_data, target } = params;
    
    const requestData: any = {};
    if (service_data) {
      Object.assign(requestData, service_data);
    }
    if (target) {
      Object.assign(requestData, target);
    }

    return this.request<ServiceCallResponse>(connection, `/api/services/${domain}/${service}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestData),
    });
  }

  // Comprehensive sync with detailed analytics
  async syncWithAnalytics(connection: Connection): Promise<SyncResponse & { analytics: HomeAssistantSyncStatus }> {
    this.logger.log('Syncing Home Assistant data with analytics', { connectionId: connection.id });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];
    const analytics: HomeAssistantSyncStatus = {
      location_tracking: { persons: 0, device_trackers: 0, zones: 0 },
      media_players: { total: 0, active: 0, playing: 0 },
      lights: { total: 0, on: 0, available: 0 },
      cameras: { total: 0, active: 0, motion_detected: 0 },
      automations: { total: 0, enabled: 0 },
      scenes: { total: 0 },
    };

    try {
      // Get all states for analysis
      const allStates = await this.request<HomeAssistantState[]>(connection, '/api/states');
      
      // Analyze location tracking
      const persons = allStates.filter(s => s.entity_id.startsWith('person.')) as PersonState[];
      const deviceTrackers = allStates.filter(s => s.entity_id.startsWith('device_tracker.')) as DeviceTrackerState[];
      const zones = allStates.filter(s => s.entity_id.startsWith('zone.')) as ZoneState[];
      
      analytics.location_tracking = {
        persons: persons.length,
        device_trackers: deviceTrackers.length,
        zones: zones.length,
        last_update: new Date().toISOString(),
      };

      // Analyze media players
      const mediaPlayers = allStates.filter(s => s.entity_id.startsWith('media_player.')) as MediaPlayerState[];
      const activeMediaPlayers = mediaPlayers.filter(p => !['unavailable', 'unknown'].includes(p.state));
      const playingMediaPlayers = mediaPlayers.filter(p => p.state === 'playing');
      
      analytics.media_players = {
        total: mediaPlayers.length,
        active: activeMediaPlayers.length,
        playing: playingMediaPlayers.length,
        last_update: new Date().toISOString(),
      };

      // Analyze lights
      const lights = allStates.filter(s => s.entity_id.startsWith('light.')) as LightState[];
      const availableLights = lights.filter(l => !['unavailable', 'unknown'].includes(l.state));
      const onLights = lights.filter(l => l.state === 'on');
      
      analytics.lights = {
        total: lights.length,
        on: onLights.length,
        available: availableLights.length,
        last_update: new Date().toISOString(),
      };

      // Analyze cameras
      const cameras = allStates.filter(s => s.entity_id.startsWith('camera.')) as CameraState[];
      const activeCameras = cameras.filter(c => !['unavailable', 'unknown'].includes(c.state));
      
      analytics.cameras = {
        total: cameras.length,
        active: activeCameras.length,
        motion_detected: 0, // Would need additional state checks for motion sensors
        last_update: new Date().toISOString(),
      };

      // Analyze automations and scenes
      const automations = allStates.filter(s => s.entity_id.startsWith('automation.')) as AutomationState[];
      const scenes = allStates.filter(s => s.entity_id.startsWith('scene.')) as SceneState[];
      const enabledAutomations = automations.filter(a => a.state === 'on');
      
      analytics.automations = {
        total: automations.length,
        enabled: enabledAutomations.length,
        last_triggered: enabledAutomations
          .map(a => a.attributes.last_triggered)
          .filter(Boolean)
          .sort()
          .pop(),
      };
      
      analytics.scenes = {
        total: scenes.length,
        last_activated: new Date().toISOString(),
      };

      syncResults.push({
        api: 'Home Assistant Comprehensive Sync',
        data: {
          states: allStates.length,
          breakdown: {
            persons: persons.length,
            device_trackers: deviceTrackers.length,
            zones: zones.length,
            media_players: mediaPlayers.length,
            lights: lights.length,
            cameras: cameras.length,
            automations: automations.length,
            scenes: scenes.length,
          },
        },
      });

    } catch (error) {
      const errorMsg = `Comprehensive sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    const response = {
      success: errors.length === 0,
      message: `Comprehensive sync completed. Analytics generated for ${Object.keys(analytics).length} domains.`,
      data: {
        results: syncResults,
        errors,
      },
      analytics,
    };

    return response;
  }
}