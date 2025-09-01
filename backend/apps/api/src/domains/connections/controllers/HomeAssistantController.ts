import { Controller, Get, Post, Body, Param, Query, Logger, BadRequestException, NotFoundException } from '@nestjs/common';

import { ConnectionService } from '../services/ConnectionService';
import { HomeAssistantAutomationService } from '../services/HomeAssistantAutomationService';
import { HomeAssistantClient } from '../clients/HomeAssistantClient';
import { OllamaService } from '../../llm/services/OllamaService';
import type { 
  LightControlParams,
  NotificationParams,
  ConversationProcessParams,
} from '../clients/types/home-assistant';

@Controller('connections/home-assistant')
export class HomeAssistantController {
  private readonly logger = new Logger(HomeAssistantController.name);

  constructor(
    private readonly connectionService: ConnectionService,
    private readonly automationService: HomeAssistantAutomationService,
    private readonly haClient: HomeAssistantClient,
    private readonly ollamaService: OllamaService,
  ) {}

  private async getConnection(connectionId: string) {
    // For now, we'll use a placeholder context - this should be updated to use proper request context
    const context = { userId: 'system' };
    const connection = await this.connectionService.findOne(context, connectionId);
    if (!connection) {
      throw new NotFoundException(`Connection ${connectionId} not found`);
    }
    if (!connection.accessToken) {
      throw new BadRequestException(`Connection ${connectionId} is not authenticated`);
    }
    return connection;
  }

  // Dashboard and Status Endpoints
  @Get(':connectionId/dashboard')
  async getDashboard(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.automationService.getDashboardStatus(connection);
  }

  @Get(':connectionId/sync')
  async syncData(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.syncWithAnalytics(connection);
  }

  // Location Tracking Endpoints
  @Get(':connectionId/location/persons')
  async getPersons(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getPersonStates(connection);
  }

  @Get(':connectionId/location/person/:personId')
  async getPersonLocation(
    @Param('connectionId') connectionId: string,
    @Param('personId') personId: string
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getPersonLocation(connection, personId);
  }

  @Get(':connectionId/location/device-trackers')
  async getDeviceTrackers(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getDeviceTrackerStates(connection);
  }

  @Get(':connectionId/location/zones')
  async getZones(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getZoneStates(connection);
  }

  @Post(':connectionId/location/person/:personId/handle-change')
  async handleLocationChange(
    @Param('connectionId') connectionId: string,
    @Param('personId') personId: string
  ) {
    const connection = await this.getConnection(connectionId);
    return this.automationService.handleLocationChange(connection, personId);
  }

  // Media Player Endpoints
  @Get(':connectionId/media/players')
  async getMediaPlayers(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getMediaPlayerStates(connection);
  }

  @Get(':connectionId/media/active')
  async getActiveMediaPlayers(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getActiveMediaPlayers(connection);
  }

  @Get(':connectionId/media/playing')
  async getCurrentlyPlaying(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getCurrentlyPlaying(connection);
  }

  @Get(':connectionId/media/insights')
  async getMediaInsights(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.automationService.getMediaConsumptionInsights(connection);
  }

  @Post(':connectionId/media/pause-all')
  async pauseAllMedia(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    const pausedDevices = await this.automationService.pauseAllMedia(connection);
    return { pausedDevices, count: pausedDevices.length };
  }

  @Post(':connectionId/media/:entityId/control')
  async controlMediaPlayer(
    @Param('connectionId') connectionId: string,
    @Param('entityId') entityId: string,
    @Body() body: { 
      action: 'play' | 'pause' | 'stop' | 'next_track' | 'previous_track' | 'volume_up' | 'volume_down' | 'volume_mute' | 'volume_set';
      volume?: number;
    }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.controlMediaPlayer(connection, entityId, body.action, body.volume);
  }

  // Light Control Endpoints
  @Get(':connectionId/lights')
  async getLights(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getLightStates(connection);
  }

  @Post(':connectionId/lights/turn-on')
  async turnOnLights(
    @Param('connectionId') connectionId: string,
    @Body() params: LightControlParams
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.turnOnLight(connection, params);
  }

  @Post(':connectionId/lights/turn-off')
  async turnOffLights(
    @Param('connectionId') connectionId: string,
    @Body() body: { entity_id: string | string[] }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.turnOffLight(connection, body.entity_id);
  }

  @Post(':connectionId/lights/toggle')
  async toggleLights(
    @Param('connectionId') connectionId: string,
    @Body() body: { entity_id: string | string[] }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.toggleLight(connection, body.entity_id);
  }

  @Post(':connectionId/lights/set-brightness')
  async setBrightness(
    @Param('connectionId') connectionId: string,
    @Body() body: { entity_id: string | string[]; brightness: number }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.setBrightness(connection, body.entity_id, body.brightness);
  }

  @Post(':connectionId/lights/set-color')
  async setColor(
    @Param('connectionId') connectionId: string,
    @Body() body: { entity_id: string | string[]; color: { r: number; g: number; b: number } }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.setColor(connection, body.entity_id, body.color);
  }

  @Post(':connectionId/lights/adaptive')
  async adaptiveLighting(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.automationService.adaptiveLighting(connection);
  }

  @Post(':connectionId/lights/scenario')
  async createAmbientLighting(
    @Param('connectionId') connectionId: string,
    @Body() body: { scenario: 'evening' | 'movie' | 'bedtime' | 'work' }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.automationService.createAmbientLighting(connection, body.scenario);
  }

  // Camera and Security Endpoints
  @Get(':connectionId/cameras')
  async getCameras(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getCameraStates(connection);
  }

  @Get(':connectionId/cameras/:entityId/image')
  async getCameraImage(
    @Param('connectionId') connectionId: string,
    @Param('entityId') entityId: string
  ) {
    const connection = await this.getConnection(connectionId);
    const imageBuffer = await this.haClient.getCameraImage(connection, entityId);
    return {
      entityId,
      imageSize: imageBuffer.length,
      timestamp: new Date().toISOString(),
    };
  }

  @Post(':connectionId/cameras/:entityId/snapshot')
  async takeCameraSnapshot(
    @Param('connectionId') connectionId: string,
    @Param('entityId') entityId: string,
    @Body() body?: { filename?: string }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.takeCameraSnapshot(connection, entityId, body?.filename);
  }

  @Get(':connectionId/security/status')
  async getSecurityStatus(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.automationService.securityMonitoring(connection);
  }

  @Post(':connectionId/security/snapshot')
  async captureSecuritySnapshot(
    @Param('connectionId') connectionId: string,
    @Body() body: { reason: string }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.automationService.captureSecuritySnapshot(connection, body.reason);
  }

  // Automation and Scene Endpoints
  @Get(':connectionId/automations')
  async getAutomations(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getAutomationStates(connection);
  }

  @Get(':connectionId/scenes')
  async getScenes(@Param('connectionId') connectionId: string) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.getSceneStates(connection);
  }

  @Post(':connectionId/automations/:entityId/trigger')
  async triggerAutomation(
    @Param('connectionId') connectionId: string,
    @Param('entityId') entityId: string
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.triggerAutomation(connection, entityId);
  }

  @Post(':connectionId/scenes/:entityId/activate')
  async activateScene(
    @Param('connectionId') connectionId: string,
    @Param('entityId') entityId: string
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.activateScene(connection, entityId);
  }

  // Notification Endpoints
  @Post(':connectionId/notify')
  async sendNotification(
    @Param('connectionId') connectionId: string,
    @Body() params: NotificationParams
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.sendNotification(connection, params);
  }

  @Post(':connectionId/tts')
  async sendTTSAnnouncement(
    @Param('connectionId') connectionId: string,
    @Body() body: {
      message: string;
      entity_id: string;
      language?: string;
      cache?: boolean;
    }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.sendTTSAnnouncement(
      connection,
      body.message,
      body.entity_id,
      { language: body.language, cache: body.cache }
    );
  }

  // Voice Command Endpoints
  @Post(':connectionId/voice/process')
  async processVoiceCommand(
    @Param('connectionId') connectionId: string,
    @Body() body: { command: string }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.automationService.processVoiceCommand(connection, body.command);
  }

  @Post(':connectionId/conversation')
  async processConversation(
    @Param('connectionId') connectionId: string,
    @Body() params: ConversationProcessParams
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.processConversation(connection, params);
  }

  // Search Endpoints
  @Post(':connectionId/search')
  async searchCIServer(
    @Param('connectionId') connectionId: string,
    @Body() body: {
      query: string;
      category?: 'people' | 'places' | 'things' | 'events' | 'locations' | 'actions' | 'jobs' | 'all';
      limit?: number;
      responseType?: 'json' | 'tts' | 'notification';
      ttsEntityId?: string;
      notificationTarget?: string;
    }
  ) {
    const connection = await this.getConnection(connectionId);
    const context = { userId: connection.user?.id || 'system' };
    
    try {
      // Execute search via LLM tool
      const searchResults = await this.ollamaService.chat(
        context,
        [
          {
            role: 'user',
            content: `Search for: ${body.query}${body.category ? ` in category: ${body.category}` : ''}`
          }
        ],
        {
          enableTools: true,
          enableThinking: false,
        }
      );

      const results = {
        query: body.query,
        category: body.category || 'all',
        results: searchResults,
        timestamp: new Date().toISOString(),
      };

      // Handle different response types
      switch (body.responseType) {
        case 'tts':
          if (body.ttsEntityId) {
            const summary = this.formatSearchResultsForTTS(results);
            await this.haClient.sendTTSAnnouncement(connection, summary, body.ttsEntityId);
            return { ...results, ttsResponse: summary };
          }
          break;
        case 'notification':
          const summary = this.formatSearchResultsForNotification(results);
          await this.haClient.sendNotification(connection, {
            message: summary,
            title: `Search Results for "${body.query}"`,
            target: body.notificationTarget,
          });
          return { ...results, notificationSent: true };
        default:
          return results;
      }

      return results;
    } catch (error) {
      this.logger.error('CI Server search failed', {
        connectionId,
        query: body.query,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadRequestException('Search failed');
    }
  }

  @Post(':connectionId/voice/search')
  async processVoiceSearch(
    @Param('connectionId') connectionId: string,
    @Body() body: { 
      command: string;
      responseEntityId?: string; // Entity ID for TTS response
      notificationTarget?: string; // Target for notifications
    }
  ) {
    const connection = await this.getConnection(connectionId);
    const context = { userId: connection.user?.id || 'system' };
    
    try {
      // Parse voice command to extract search intent and parameters
      const searchIntent = await this.parseVoiceSearchIntent(context, body.command);
      
      if (!searchIntent.isSearchCommand) {
        return {
          handled: false,
          message: 'Command not recognized as a search request',
          originalCommand: body.command,
        };
      }

      // Execute the search
      const searchResults = await this.ollamaService.chat(
        context,
        [
          {
            role: 'user',
            content: `Search for: ${searchIntent.query}${searchIntent.category ? ` in category: ${searchIntent.category}` : ''}`
          }
        ],
        {
          enableTools: true,
          enableThinking: false,
        }
      );

      const results: any = {
        originalCommand: body.command,
        parsedIntent: searchIntent,
        searchResults,
        handled: true,
        timestamp: new Date().toISOString(),
      };

      // Provide voice response if requested
      if (body.responseEntityId) {
        const ttsResponse = this.formatSearchResultsForTTS(results);
        await this.haClient.sendTTSAnnouncement(connection, ttsResponse, body.responseEntityId);
        results.ttsResponse = ttsResponse;
      }

      // Send notification if requested
      if (body.notificationTarget) {
        const notificationSummary = this.formatSearchResultsForNotification(results);
        await this.haClient.sendNotification(connection, {
          message: notificationSummary,
          title: `Search: "${searchIntent.query}"`,
          target: body.notificationTarget,
        });
        results.notificationSent = true;
      }

      return results;
    } catch (error) {
      this.logger.error('Voice search processing failed', {
        connectionId,
        command: body.command,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadRequestException('Voice search processing failed');
    }
  }

  // Generic Service Call Endpoint
  @Post(':connectionId/service')
  async callService(
    @Param('connectionId') connectionId: string,
    @Body() body: {
      domain: string;
      service: string;
      service_data?: Record<string, any>;
      target?: {
        entity_id?: string | string[];
        device_id?: string | string[];
        area_id?: string | string[];
      };
    }
  ) {
    const connection = await this.getConnection(connectionId);
    return this.haClient.callService(connection, body);
  }

  // Helper Methods for Voice Search Processing
  private async parseVoiceSearchIntent(
    context: any,
    command: string
  ): Promise<{
    isSearchCommand: boolean;
    query?: string;
    category?: 'people' | 'places' | 'things' | 'events' | 'locations' | 'actions' | 'jobs';
    confidence?: number;
  }> {
    const lowerCommand = command.toLowerCase();
    
    // Keywords that indicate search intent
    const searchKeywords = [
      'find', 'search', 'look for', 'show me', 'where is', 'what is', 'who is',
      'locate', 'get', 'list', 'display', 'tell me about'
    ];
    
    const hasSearchKeyword = searchKeywords.some(keyword => 
      lowerCommand.includes(keyword)
    );
    
    if (!hasSearchKeyword) {
      return { isSearchCommand: false };
    }

    // Category detection patterns
    const categoryPatterns = {
      people: /\b(person|people|user|family|member|who|someone)\b/i,
      places: /\b(place|location|room|area|zone|where|house|building)\b/i,
      things: /\b(device|light|camera|sensor|switch|thing|object|entity)\b/i,
      events: /\b(event|automation|trigger|alert|notification|happened|occurred)\b/i,
      actions: /\b(action|service|control|turn|activate|run|execute|do)\b/i,
      jobs: /\b(job|task|process|queue|running|background|sync)\b/i,
    };

    let detectedCategory: any = undefined;
    for (const [category, pattern] of Object.entries(categoryPatterns)) {
      if (pattern.test(command)) {
        detectedCategory = category;
        break;
      }
    }

    // Extract query by removing search keywords and common words
    let query = command;
    for (const keyword of searchKeywords) {
      query = query.replace(new RegExp(keyword, 'gi'), '');
    }
    
    // Clean up the query
    query = query.replace(/\b(the|a|an|my|all|any)\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();

    return {
      isSearchCommand: true,
      query: query || command,
      category: detectedCategory,
      confidence: hasSearchKeyword ? 0.8 : 0.4,
    };
  }

  private formatSearchResultsForTTS(results: any): string {
    try {
      // Extract meaningful information from search results for TTS
      const query = results.query || results.parsedIntent?.query;
      const category = results.category || results.parsedIntent?.category || 'all';
      
      if (!results.searchResults?.message?.content) {
        return `I searched for ${query} but didn't find any specific results.`;
      }

      const content = results.searchResults.message.content;
      
      // Truncate for TTS to avoid overly long announcements
      const maxLength = 200;
      const truncatedContent = content.length > maxLength 
        ? content.substring(0, maxLength) + '...' 
        : content;
      
      return `Search results for ${query}: ${truncatedContent}`;
    } catch (error) {
      return `I completed the search but had trouble formatting the results.`;
    }
  }

  private formatSearchResultsForNotification(results: any): string {
    try {
      const query = results.query || results.parsedIntent?.query;
      const content = results.searchResults?.message?.content;
      
      if (!content) {
        return `Search completed for "${query}" but no specific results found.`;
      }

      // Format for notification (can be longer than TTS)
      const maxLength = 500;
      return content.length > maxLength 
        ? content.substring(0, maxLength) + '...'
        : content;
    } catch (error) {
      return 'Search completed but results could not be formatted.';
    }
  }
}