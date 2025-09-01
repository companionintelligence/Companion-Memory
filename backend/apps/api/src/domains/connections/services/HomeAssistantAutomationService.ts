import { Injectable, Logger } from '@nestjs/common';

import type { Connection } from '../types';
import { HomeAssistantClient } from '../clients/HomeAssistantClient';
import type { 
  PersonState, 
  MediaPlayerState, 
  LightState, 
  CameraState,
  HomeAssistantSyncStatus,
} from '../clients/types/home-assistant';

@Injectable()
export class HomeAssistantAutomationService {
  private readonly logger = new Logger(HomeAssistantAutomationService.name);

  constructor(private readonly haClient: HomeAssistantClient) {}

  // Location-based Automations
  async handleLocationChange(connection: Connection, personId: string): Promise<{
    location: PersonState;
    automationsTriggered: string[];
  }> {
    const location = await this.haClient.getPersonLocation(connection, personId);
    const automationsTriggered: string[] = [];

    this.logger.log(`Location change detected for ${personId}: ${location.state}`, {
      connectionId: connection.id,
      personId,
      location: location.state,
    });

    // Example automation: Turn on lights when arriving home
    if (location.state === 'home' && location.attributes.source === 'device_tracker') {
      try {
        await this.haClient.callService(connection, {
          domain: 'scene',
          service: 'turn_on',
          service_data: { entity_id: 'scene.welcome_home' },
        });
        automationsTriggered.push('Welcome Home Scene');
      } catch (error) {
        this.logger.warn('Failed to trigger Welcome Home scene', { error });
      }

      // Send welcome notification
      try {
        await this.haClient.sendNotification(connection, {
          message: `Welcome home! Lights have been turned on.`,
          title: 'Home Assistant',
        });
        automationsTriggered.push('Welcome Notification');
      } catch (error) {
        this.logger.warn('Failed to send welcome notification', { error });
      }
    }

    // Example automation: Turn off lights when leaving home
    if (location.state === 'not_home') {
      try {
        await this.haClient.callService(connection, {
          domain: 'light',
          service: 'turn_off',
          service_data: { entity_id: 'all' },
        });
        automationsTriggered.push('All Lights Off');
      } catch (error) {
        this.logger.warn('Failed to turn off all lights', { error });
      }
    }

    return { location, automationsTriggered };
  }

  // Media Consumption Tracking and Control
  async getMediaConsumptionInsights(connection: Connection): Promise<{
    currentlyWatching: MediaPlayerState[];
    currentlyListening: MediaPlayerState[];
    suggestions: string[];
  }> {
    const mediaPlayers = await this.haClient.getActiveMediaPlayers(connection);
    
    const currentlyWatching = mediaPlayers.filter(player => 
      player.attributes.device_class === 'tv' && player.state === 'playing'
    );
    
    const currentlyListening = mediaPlayers.filter(player => 
      ['speaker', 'receiver'].includes(player.attributes.device_class || '') && player.state === 'playing'
    );

    const suggestions: string[] = [];
    
    // Generate suggestions based on current activity
    if (currentlyWatching.length === 0 && currentlyListening.length === 0) {
      suggestions.push('No media currently playing - would you like to start something?');
    }
    
    if (currentlyWatching.length > 1) {
      suggestions.push('Multiple TVs are playing - consider consolidating viewing');
    }

    return {
      currentlyWatching,
      currentlyListening,
      suggestions,
    };
  }

  async pauseAllMedia(connection: Connection): Promise<string[]> {
    const activeMediaPlayers = await this.haClient.getCurrentlyPlaying(connection);
    const pausedDevices: string[] = [];

    for (const player of activeMediaPlayers) {
      try {
        await this.haClient.controlMediaPlayer(connection, player.entity_id, 'pause');
        pausedDevices.push(player.attributes.friendly_name);
      } catch (error) {
        this.logger.warn(`Failed to pause ${player.entity_id}`, { error });
      }
    }

    return pausedDevices;
  }

  // Intelligent Lighting Control
  async createAmbientLighting(connection: Connection, scenario: 'evening' | 'movie' | 'bedtime' | 'work'): Promise<{
    lightsAdjusted: string[];
    scenario: string;
  }> {
    const lights = await this.haClient.getLightStates(connection);
    const availableLights = lights.filter(light => !['unavailable', 'unknown'].includes(light.state));
    const lightsAdjusted: string[] = [];

    const scenarios = {
      evening: { brightness: 180, color: { r: 255, g: 193, b: 120 } }, // Warm white
      movie: { brightness: 80, color: { r: 128, g: 0, b: 128 } }, // Dim purple
      bedtime: { brightness: 50, color: { r: 255, g: 100, b: 100 } }, // Very dim red
      work: { brightness: 255, color: { r: 255, g: 255, b: 255 } }, // Bright white
    };

    const config = scenarios[scenario];

    for (const light of availableLights) {
      try {
        await this.haClient.turnOnLight(connection, {
          entity_id: light.entity_id,
          brightness: config.brightness,
          rgb_color: [config.color.r, config.color.g, config.color.b],
          transition: 3, // 3 second transition
        });
        lightsAdjusted.push(light.attributes.friendly_name);
      } catch (error) {
        this.logger.warn(`Failed to adjust ${light.entity_id}`, { error });
      }
    }

    return { lightsAdjusted, scenario };
  }

  async adaptiveLighting(connection: Connection): Promise<{
    adjustments: string[];
    reasoning: string;
  }> {
    const currentHour = new Date().getHours();
    const mediaPlayers = await this.haClient.getCurrentlyPlaying(connection);
    const isWatchingTV = mediaPlayers.some(p => p.attributes.device_class === 'tv');

    let scenario: 'evening' | 'movie' | 'bedtime' | 'work';
    let reasoning: string;

    if (currentHour >= 22 || currentHour <= 6) {
      scenario = 'bedtime';
      reasoning = 'Late night/early morning - using dim red lighting for sleep preparation';
    } else if (isWatchingTV) {
      scenario = 'movie';
      reasoning = 'TV is playing - creating movie ambiance with dim lighting';
    } else if (currentHour >= 17 && currentHour <= 21) {
      scenario = 'evening';
      reasoning = 'Evening time - using warm ambient lighting';
    } else {
      scenario = 'work';
      reasoning = 'Daytime/work hours - using bright white lighting for productivity';
    }

    const result = await this.createAmbientLighting(connection, scenario);
    
    return {
      adjustments: result.lightsAdjusted,
      reasoning,
    };
  }

  // Security and Monitoring
  async securityMonitoring(connection: Connection): Promise<{
    cameras: CameraState[];
    alerts: string[];
    recommendations: string[];
  }> {
    const cameras = await this.haClient.getCameraStates(connection);
    const persons = await this.haClient.getPersonStates(connection);
    
    const alerts: string[] = [];
    const recommendations: string[] = [];
    
    // Check if anyone is home
    const peopleHome = persons.filter(person => person.state === 'home').length;
    
    if (peopleHome === 0) {
      alerts.push('No one is currently home - security monitoring is active');
      recommendations.push('Consider enabling motion detection alerts');
    }
    
    // Check camera availability
    const unavailableCameras = cameras.filter(camera => camera.state === 'unavailable');
    if (unavailableCameras.length > 0) {
      alerts.push(`${unavailableCameras.length} camera(s) are unavailable`);
      recommendations.push('Check camera connectivity and power status');
    }

    return {
      cameras,
      alerts,
      recommendations,
    };
  }

  async captureSecuritySnapshot(connection: Connection, reason: string): Promise<{
    snapshots: string[];
    timestamp: string;
    reason: string;
  }> {
    const cameras = await this.haClient.getCameraStates(connection);
    const activeCameras = cameras.filter(camera => camera.state !== 'unavailable');
    const snapshots: string[] = [];
    const timestamp = new Date().toISOString();

    for (const camera of activeCameras) {
      try {
        const filename = `/tmp/security_${camera.entity_id.replace('camera.', '')}_${Date.now()}.jpg`;
        await this.haClient.takeCameraSnapshot(connection, camera.entity_id, filename);
        snapshots.push(filename);
        
        this.logger.log(`Security snapshot captured from ${camera.entity_id}`, {
          camera: camera.entity_id,
          filename,
          reason,
        });
      } catch (error) {
        this.logger.warn(`Failed to capture snapshot from ${camera.entity_id}`, { error });
      }
    }

    // Send notification about security event
    try {
      await this.haClient.sendNotification(connection, {
        message: `Security snapshot captured: ${reason}. ${snapshots.length} camera(s) recorded.`,
        title: 'Security Alert',
        data: { 
          snapshots,
          reason,
          timestamp,
        },
      });
    } catch (error) {
      this.logger.warn('Failed to send security notification', { error });
    }

    return { snapshots, timestamp, reason };
  }

  // Voice Command Integration
  async processVoiceCommand(connection: Connection, command: string): Promise<{
    response: string;
    actionsExecuted: string[];
    confidence: number;
  }> {
    const actionsExecuted: string[] = [];
    let response = '';
    let confidence = 0;

    try {
      // First, try Home Assistant's built-in conversation
      const haResponse = await this.haClient.processConversation(connection, {
        text: command,
        language: 'en',
      });
      
      response = haResponse.response.speech.plain.speech;
      confidence = haResponse.response.response_type === 'action_done' ? 0.9 : 0.6;
      actionsExecuted.push('Home Assistant Conversation');

    } catch (error) {
      // Fallback to custom command processing
      const lowerCommand = command.toLowerCase();
      
      if (lowerCommand.includes('turn on') && lowerCommand.includes('light')) {
        try {
          const result = await this.haClient.callService(connection, {
            domain: 'light',
            service: 'turn_on',
            service_data: { entity_id: 'all' },
          });
          response = 'All lights have been turned on';
          actionsExecuted.push('Turn on all lights');
          confidence = 0.8;
        } catch (err) {
          response = 'Sorry, I could not turn on the lights';
          confidence = 0.3;
        }
      } else if (lowerCommand.includes('turn off') && lowerCommand.includes('light')) {
        try {
          await this.haClient.callService(connection, {
            domain: 'light',
            service: 'turn_off',
            service_data: { entity_id: 'all' },
          });
          response = 'All lights have been turned off';
          actionsExecuted.push('Turn off all lights');
          confidence = 0.8;
        } catch (err) {
          response = 'Sorry, I could not turn off the lights';
          confidence = 0.3;
        }
      } else if (lowerCommand.includes('pause') && lowerCommand.includes('music')) {
        const pausedDevices = await this.pauseAllMedia(connection);
        response = pausedDevices.length > 0 
          ? `Paused media on ${pausedDevices.join(', ')}`
          : 'No media was playing to pause';
        actionsExecuted.push('Pause media');
        confidence = 0.7;
      } else {
        response = 'I\'m not sure how to help with that command';
        confidence = 0.1;
      }
    }

    this.logger.log('Voice command processed', {
      command,
      response,
      actionsExecuted,
      confidence,
    });

    return { response, actionsExecuted, confidence };
  }

  // Comprehensive Status Dashboard
  async getDashboardStatus(connection: Connection): Promise<HomeAssistantSyncStatus & {
    recommendations: string[];
    alerts: string[];
    quickActions: Array<{ label: string; action: string; params?: any }>;
  }> {
    const syncResult = await this.haClient.syncWithAnalytics(connection);
    const status = syncResult.analytics;
    
    const recommendations: string[] = [];
    const alerts: string[] = [];
    const quickActions: Array<{ label: string; action: string; params?: any }> = [];

    // Generate recommendations based on status
    if (status.lights.on > status.lights.total * 0.8) {
      recommendations.push('Many lights are on - consider turning off unused lights');
      quickActions.push({ label: 'Turn off all lights', action: 'lights_off_all' });
    }

    if (status.media_players.playing > 2) {
      recommendations.push('Multiple media players are active - consider consolidating');
      quickActions.push({ label: 'Pause all media', action: 'media_pause_all' });
    }

    if (status.location_tracking.persons === 0) {
      alerts.push('No person entities found - location tracking may not be set up');
    }

    // Add common quick actions
    quickActions.push(
      { label: 'Activate evening scene', action: 'lighting_scenario', params: { scenario: 'evening' } },
      { label: 'Security snapshot', action: 'security_snapshot', params: { reason: 'Manual request' } },
      { label: 'Adaptive lighting', action: 'adaptive_lighting' },
    );

    return {
      ...status,
      recommendations,
      alerts,
      quickActions,
    };
  }
}