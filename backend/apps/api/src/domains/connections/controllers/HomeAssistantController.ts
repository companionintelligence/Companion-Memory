import { Controller, Get, Post, Body, Param, Query, Logger, BadRequestException, NotFoundException } from '@nestjs/common';

import { ConnectionService } from '../services/ConnectionService';
import { HomeAssistantAutomationService } from '../services/HomeAssistantAutomationService';
import { HomeAssistantClient } from '../clients/HomeAssistantClient';
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
}