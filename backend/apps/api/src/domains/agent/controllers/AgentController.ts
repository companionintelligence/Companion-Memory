import { Controller, Get, Param, Post, Query, UseGuards, Body } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { ValidationPipe } from '@ci/common/pipes';

import { AgentServiceAuthGuard } from '../guards/AgentServiceAuthGuard';
import { AgentReadService } from '../services/AgentReadService';
import {
  agentDocumentQuerySchema,
  agentGraphReadSchema,
  agentRecentActivitySchema,
  agentSearchSchema,
  agentThreadQuerySchema,
  type AgentDocumentQuery,
  type AgentGraphReadInput,
  type AgentRecentActivityInput,
  type AgentSearchInput,
  type AgentThreadQuery,
} from '../types';

@UseGuards(AgentServiceAuthGuard)
@Controller('agent/v1')
export class AgentController {
  constructor(private readonly agentReadService: AgentReadService) {}

  @Get('capabilities')
  async getCapabilities() {
    return this.agentReadService.getCapabilities();
  }

  @Get('context')
  async getContext(@Context() context: RequestContext) {
    return this.agentReadService.getUserContext(toServiceContext(context));
  }

  @Post('search')
  async search(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(agentSearchSchema)) input: AgentSearchInput,
  ) {
    return this.agentReadService.searchMemory(toServiceContext(context), input);
  }

  @Post('graph/read')
  async readGraph(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(agentGraphReadSchema)) input: AgentGraphReadInput,
  ) {
    return this.agentReadService.readEntityGraph(toServiceContext(context), input);
  }

  @Post('activity/recent')
  async getRecentActivity(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(agentRecentActivitySchema)) input: AgentRecentActivityInput,
  ) {
    return this.agentReadService.getRecentActivity(toServiceContext(context), input);
  }

  @Get('threads/:id')
  async getThread(
    @Context() context: RequestContext,
    @Param('id') threadId: string,
    @Query(new ValidationPipe(agentThreadQuerySchema)) query: AgentThreadQuery,
  ) {
    return this.agentReadService.getThread(toServiceContext(context), threadId, query.maxMessages);
  }

  @Get('documents/:id')
  async getDocument(
    @Context() context: RequestContext,
    @Param('id') documentId: string,
    @Query(new ValidationPipe(agentDocumentQuerySchema)) query: AgentDocumentQuery,
  ) {
    return this.agentReadService.getDocument(toServiceContext(context), documentId, query);
  }
}
