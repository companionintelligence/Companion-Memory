import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import config from '@ci/configuration';
import { EventService, Events, EventPayloads, OnEvent } from '@ci/domains/events';

import { ConnectionService } from '../services/ConnectionService';
import type { CompleteConnectionDto, CreateConnectionDto, UpdateConnectionDto } from '../types';

const createConnectionSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  providerId: z.string().uuid('Invalid provider ID'),
  clientid: z.string().optional(),
  clientkey: z.string().optional(),
  clientsecret: z.string().optional(),
  schedule: z.string().optional(),
});

const updateConnectionSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  active: z.boolean().optional(),
  clientid: z.string().optional(),
  clientkey: z.string().optional(),
  clientsecret: z.string().optional(),
  schedule: z.string().optional(),
});

const completeConnectionSchema = z.object({
  state: z.string(),
  code: z.string(),
});

@Controller('connections')
export class ConnectionsController {
  private logger = new LoggerService(ConnectionsController.name);

  constructor(
    private readonly connectionService: ConnectionService,
    private readonly eventService: EventService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createConnectionSchema)) input: CreateConnectionDto,
  ) {
    return this.connectionService.create(context, input);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    return this.connectionService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.connectionService.findOne(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(updateConnectionSchema)) input: UpdateConnectionDto,
  ) {
    return this.connectionService.update(context, id, input);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async delete(@Context() context: RequestContext, @Param('id') id: string) {
    await this.connectionService.delete(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/connect')
  async connect(@Context() context: RequestContext, @Param('id') id: string) {
    try {
      return this.connectionService.connect(context, id);
    } catch (error) {
      this.logger.error('Connect endpoint error', {
        connectionId: id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('complete')
  @HttpCode(200)
  async completeCallback(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(completeConnectionSchema)) body: CompleteConnectionDto,
  ) {
    const { state, code } = body;

    try {
      const result = await this.connectionService.callback(context, state, code);

      return {
        success: true,
        connection: result,
      };
    } catch (error) {
      this.logger.error('Error completing OAuth callback', {
        error: error instanceof Error ? error.message : 'Unknown error',
        connectionId: state,
        userId: context.userId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/sync')
  @HttpCode(200)
  async sync(@Context() context: RequestContext, @Param('id') id: string) {
    return this.connectionService.sync(context, id, false);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async cronProcessConnections() {
    if (!config.features['scheduled.connection.fetching']) {
      return;
    }

    this.logger.log('Processing connection sync cron');

    const activeConnections = await this.connectionService.findSyncTargetsByUserId();

    for (const [userId, connectionIds] of activeConnections) {
      for (const connectionId of connectionIds) {
        this.eventService.send(Events.SYNC_CONNECTION, {
          userId,
          connectionId,
        });
      }
    }
  }

  @OnEvent(Events.SYNC_CONNECTION)
  async syncConnection(payload: EventPayloads[Events.SYNC_CONNECTION]) {
    const context: RequestContext = {
      userId: payload.userId,
    };

    this.logger.log('Syncing connection', {
      connectionId: payload.connectionId,
      userId: payload.userId,
    });

    try {
      const result = await this.connectionService.sync(context, payload.connectionId);

      this.logger.log('Connection sync completed', {
        connectionId: payload.connectionId,
        success: result.success,
        message: result.message,
      });
    } catch (error) {
      // Keep in mind this swallows the error and marks the job as a success.
      // Is this a transient failure? Should we retry?

      this.logger.error('Connection sync failed', {
        connectionId: payload.connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
