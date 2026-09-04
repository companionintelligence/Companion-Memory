import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import {
  MEMORY_SCOPE,
  READ_CAPABILITY,
  RequireCapability,
  RequireScopes,
  WRITE_CAPABILITY,
} from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { AgentDispatchService } from '../services/AgentDispatchService';

const createSchema = z.object({
  sourceKind: z.string().min(1).max(80),
  sourceId: z.string().min(1).max(200),
  title: z.string().min(1).max(400),
  body: z.string().max(8000).optional().nullable(),
  taskId: z.string().uuid().optional().nullable(),
  packetMode: z.enum(['details', 'intents', 'both']).optional(),
  ask: z.string().max(4000).optional().nullable(),
});

const checkpointSchema = z.object({
  turns: z
    .array(
      z.object({
        role: z.string(),
        content: z.string(),
        thought: z.string().optional(),
      }),
    )
    .optional(),
  step: z.string().max(200).optional(),
  failed: z.boolean().optional(),
  needsUser: z.boolean().optional(),
  status: z.enum(['queued', 'running', 'blocked', 'completed', 'failed']).optional(),
  result: z.record(z.unknown()).optional(),
});

const steerSchema = z.object({
  action: z.enum(['continue', 'redirect', 'halt']),
  message: z.string().max(4000).optional(),
});

@Controller('v1/agent/jobs')
@UseGuards(JwtOrApiKeyAuthGuard)
@RequireScopes(MEMORY_SCOPE)
export class AgentJobsController {
  constructor(private readonly dispatchService: AgentDispatchService) {}

  @Post()
  @RequireCapability(WRITE_CAPABILITY)
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    return this.dispatchService.dispatch(toServiceContext(context), body);
  }

  @Get()
  @RequireCapability(READ_CAPABILITY)
  async findByThread(@Context() context: RequestContext, @Query('threadId') threadId?: string) {
    if (!threadId) {
      return { job: null };
    }

    const job = await this.dispatchService.findByThreadId(toServiceContext(context), threadId);

    return { job };
  }

  @Get(':id')
  @RequireCapability(READ_CAPABILITY)
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    const job = await this.dispatchService.findById(toServiceContext(context), id);

    if (!job) {
      throw new NotFoundException();
    }

    return job;
  }

  @Get(':id/packet')
  @RequireCapability(READ_CAPABILITY)
  async packet(@Context() context: RequestContext, @Param('id') id: string) {
    return this.dispatchService.getPacket(toServiceContext(context), id);
  }

  @Post(':id/checkpoint')
  @RequireCapability(WRITE_CAPABILITY)
  async checkpoint(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(checkpointSchema)) body: z.infer<typeof checkpointSchema>,
  ) {
    return this.dispatchService.checkpoint(toServiceContext(context), id, body);
  }

  @Post(':id/steer')
  @RequireCapability(WRITE_CAPABILITY)
  async steer(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(steerSchema)) body: z.infer<typeof steerSchema>,
  ) {
    return this.dispatchService.steer(toServiceContext(context), id, body);
  }
}
