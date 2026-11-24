import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod/v3';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import {
  AGENT_JOBS_SCOPE,
  READ_CAPABILITY,
  RequireCapability,
  RequireScopes,
  WRITE_CAPABILITY,
} from '@ci/common/decorators';
import { type ApiKeyScopedRequest, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { connectAppNameOf } from '@ci/domains/auth';

import { AgentDispatchService, type JobCaller, OWNER_CALLER } from '../services/AgentDispatchService';

/** Who is asking, for the two harness-side routes. See `assertHarnessCaller`. */
function jobCallerOf(req: ApiKeyScopedRequest): JobCaller {
  if (req.apiKeyScopes === undefined) {
    return OWNER_CALLER;
  }

  return {
    kind: 'api-key',
    connectApp: connectAppNameOf({ managedBy: req.apiKeyManagedBy, name: req.apiKeyName }),
  };
}

/**
 * `/v1/agent/jobs` is a raw-uuid plane in both directions: the `taskId` it
 * writes to `ci.agent_jobs` and echoes back in every response IS the
 * `ci.tasks.id`. GraphQL clients hold a global id (`base64("task:<uuid>")`)
 * and must decode before calling — the web app does so in
 * `lib/agentChat.ts:taskUuidFromGlobalId`. Say that in the rejection, because
 * a bare "Invalid uuid" against a base64 blob reads as a server bug and cost
 * this endpoint one silent outage already.
 */
const taskIdSchema = z
  .string()
  .uuid('taskId must be the raw ci.tasks uuid, not a GraphQL global id — decode base64("task:<uuid>") first');

/** Exported so the id contract can be asserted without standing up Nest. */
export const createDispatchSchema = z.object({
  sourceKind: z.string().min(1).max(80),
  sourceId: z.string().min(1).max(200),
  title: z.string().min(1).max(400),
  body: z.string().max(8000).optional().nullable(),
  taskId: taskIdSchema.optional().nullable(),
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

/**
 * The dispatch plane: the owner hands a task to the agent harness (create,
 * steer, read back), and the harness fetches the packet and reports on it.
 *
 * Its own scope, `agent-jobs`, which only the chat-agent connect tier carries.
 * It used to sit under `memory`, the one scope every memory-only app holds, so
 * a voice speaker's key could dispatch a job, have the harness run its `ask`
 * with the harness's wider key, and read the result back. The web and mobile
 * apps are unaffected: a session and an unscoped key skip scope checks.
 */
@Controller('v1/agent/jobs')
@UseGuards(JwtOrApiKeyAuthGuard)
@RequireScopes(AGENT_JOBS_SCOPE)
export class AgentJobsController {
  constructor(private readonly dispatchService: AgentDispatchService) {}

  @Post()
  @RequireCapability(WRITE_CAPABILITY)
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createDispatchSchema)) body: z.infer<typeof createDispatchSchema>,
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
  async packet(@Context() context: RequestContext, @Req() req: ApiKeyScopedRequest, @Param('id') id: string) {
    return this.dispatchService.getPacket(toServiceContext(context), id, jobCallerOf(req));
  }

  @Post(':id/checkpoint')
  @RequireCapability(WRITE_CAPABILITY)
  async checkpoint(
    @Context() context: RequestContext,
    @Req() req: ApiKeyScopedRequest,
    @Param('id') id: string,
    @Body(new ValidationPipe(checkpointSchema)) body: z.infer<typeof checkpointSchema>,
  ) {
    return this.dispatchService.checkpoint(toServiceContext(context), id, body, jobCallerOf(req));
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
