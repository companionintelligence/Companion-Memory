import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository, type QueryDeepPartialEntity } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { EventService, INTERACTIVE_JOB_PRIORITY } from '@ci/domains/events';
import { TaskService } from '@ci/domains/planning';

import {
  AGENT_DISPATCH_QUEUE,
  DISPATCH_QUEUED_STALE_MS,
  DISPATCH_RUNNING_STALE_MS,
} from '../constants';

import { buildDispatchPacket } from '../dispatchPacket';
import {
  AgentTaskBlockedEvent,
  AgentTaskCheckpointEvent,
  AgentTaskCompletedEvent,
  AgentTaskDispatchEvent,
  PlanningTaskResultEvent,
} from '../events';
import {
  AgentJobEntity,
  type AgentJob,
  type AgentJobStatus,
  type PacketMode,
} from '../entities/AgentJobEntity';

import { HubDoorbellService } from './HubDoorbellService';

export type CreateDispatchInput = {
  sourceKind: string;
  sourceId: string;
  title: string;
  body?: string | null;
  taskId?: string | null;
  packetMode?: PacketMode;
  ask?: string | null;
};

export type CheckpointInput = {
  turns?: Array<{ role: string; content: string; thought?: string }>;
  step?: string;
  failed?: boolean;
  needsUser?: boolean;
  status?: AgentJobStatus;
  result?: Record<string, unknown>;
};

export type SteerInput = {
  action: 'continue' | 'redirect' | 'halt';
  message?: string;
};

@Injectable()
export class AgentDispatchService {
  constructor(
    @InjectRepository(AgentJobEntity)
    private readonly jobRepository: Repository<AgentJobEntity>,
    private readonly threadService: ThreadService,
    private readonly messageService: MessageService,
    private readonly taskService: TaskService,
    private readonly eventService: EventService,
    private readonly doorbell: HubDoorbellService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentDispatchService.name);
  }

  async dispatch(context: UserServiceContext, input: CreateDispatchInput): Promise<AgentJob> {
    const title = input.title.trim();

    if (!title) {
      throw new BadRequestException('Dispatch needs a title');
    }

    let taskId = input.taskId ?? null;

    if (taskId) {
      const task = await this.taskService.findById(context, taskId);

      if (!task) {
        throw new NotFoundException(`Task ${taskId} not found`);
      }

      await this.taskService.update(context, taskId, { status: 'delegated' });
    }

    const thread = await this.threadService.create(context, {
      name: title,
      description: input.body ?? `Dispatch: ${title}`,
      kind: 'dispatch',
      generationStatus: 'idle',
    });

    const jobId = uuid7();
    const packet = buildDispatchPacket({
      jobId,
      threadId: thread.id,
      taskId,
      mode: input.packetMode,
      title,
      body: input.body,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      ask: input.ask,
    });

    const entity = await this.jobRepository.save(
      this.jobRepository.create({
        id: jobId,
        userId: context.userId,
        taskId,
        threadId: thread.id,
        harnessId: 'openclaw',
        packetMode: packet.mode,
        packet,
        status: 'queued',
        failCount: 0,
        eventJobId: null,
      }),
    );

    await this.messageService.create(context, {
      threadId: thread.id,
      role: 'user',
      model: 'memory',
      source: 'memory',
      content: packet.turns[3]?.content ?? title,
    });

    const [eventJobId] = await this.eventService.send(
      AgentTaskDispatchEvent,
      {
        userId: context.userId,
        jobId,
        threadId: thread.id,
        taskId,
      },
      { singletonKey: jobId, priority: INTERACTIVE_JOB_PRIORITY },
    );

    if (eventJobId) {
      await this.jobRepository.update({ id: jobId }, { eventJobId } as QueryDeepPartialEntity<AgentJobEntity>);
      entity.eventJobId = eventJobId;
    }

    return AgentJobEntity.toEgressType(entity);
  }

  async findById(context: UserServiceContext, id: string): Promise<AgentJob | null> {
    const entity = await this.jobRepository.findOne({ where: { id, userId: context.userId } });

    return entity ? AgentJobEntity.toEgressType(entity) : null;
  }

  async findByThreadId(context: UserServiceContext, threadId: string): Promise<AgentJob | null> {
    const entity = await this.jobRepository.findOne({
      where: { threadId, userId: context.userId },
    });

    return entity ? AgentJobEntity.toEgressType(entity) : null;
  }

  async getPacket(context: UserServiceContext, id: string): Promise<AgentJob['packet']> {
    const job = await this.requireJob(context, id);

    if (job.status === 'queued') {
      await this.jobRepository.update({ id, userId: context.userId }, { status: 'running' });
    }

    return job.packet;
  }

  async checkpoint(context: UserServiceContext, id: string, input: CheckpointInput): Promise<AgentJob> {
    const job = await this.requireJob(context, id);

    for (const turn of input.turns ?? []) {
      const role = turn.role === 'user' ? 'user' : 'assistant';
      const content = turn.thought ? `${turn.content}\n\n${turn.thought}` : turn.content;

      await this.messageService.create(context, {
        threadId: job.threadId,
        role,
        model: 'openclaw',
        source: 'openclaw',
        content,
      });
    }

    let status: AgentJobStatus = input.status ?? (job.status === 'queued' ? 'running' : job.status);
    let failStep = job.failStep;
    let failCount = job.failCount;
    let reason: string | null = null;

    if (input.status === 'failed') {
      status = 'failed';
      reason = input.step ?? 'failed';
    } else if (input.needsUser) {
      status = 'blocked';
      reason = 'needs_user';
    } else if (input.failed && input.step) {
      if (failStep === input.step) {
        failCount += 1;
      } else {
        failStep = input.step;
        failCount = 1;
      }

      if (failCount >= 2) {
        status = 'blocked';
        reason = `two_fails:${input.step}`;
      }
    }

    if (status === 'completed' || status === 'failed') {
      // terminal below
    } else if (input.status === 'completed') {
      status = 'completed';
    }

    const completed = status === 'completed' || status === 'blocked' || status === 'failed';

    await this.jobRepository.update(
      { id, userId: context.userId },
      {
        status,
        failStep,
        failCount,
        result: input.result ?? job.result,
        completedAt: completed ? new Date() : job.completedAt,
      } as QueryDeepPartialEntity<AgentJobEntity>,
    );

    const updated = await this.requireJob(context, id);

    await this.eventService.send(AgentTaskCheckpointEvent, {
      userId: context.userId,
      jobId: id,
      threadId: job.threadId,
      status,
    });

    if (status === 'blocked') {
      await this.finishBlocked(context, updated, reason ?? 'blocked');
    } else if (status === 'completed') {
      await this.finishCompleted(context, updated);
    } else if (status === 'failed') {
      await this.finishFailed(context, updated, reason ?? 'failed');
    }

    return updated;
  }

  async failStale(now = new Date()): Promise<number> {
    const queuedCutoff = new Date(now.getTime() - DISPATCH_QUEUED_STALE_MS);
    const runningCutoff = new Date(now.getTime() - DISPATCH_RUNNING_STALE_MS);
    const stale = [
      ...(await this.jobRepository.find({
        where: { status: 'queued', createdAt: LessThan(queuedCutoff) },
      })),
      ...(await this.jobRepository.find({
        where: { status: 'running', updatedAt: LessThan(runningCutoff) },
      })),
    ];

    let closed = 0;

    for (const entity of stale) {
      try {
        const context = { userId: entity.userId } as UserServiceContext;

        await this.checkpoint(context, entity.id, {
          status: 'failed',
          failed: true,
          step: 'stale',
          turns: [
            {
              role: 'assistant',
              content:
                'OpenClaw did not check in. Memory closed the job so it would not hang.',
            },
          ],
          result: { summary: 'Timed out waiting for OpenClaw' },
        });
        closed += 1;
      } catch (error) {
        this.logger.warn('Could not close stale dispatch', {
          jobId: entity.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return closed;
  }

  async steer(context: UserServiceContext, id: string, input: SteerInput): Promise<AgentJob> {
    const job = await this.requireJob(context, id);
    const message = input.message?.trim();

    if (input.action === 'halt') {
      await this.jobRepository.update(
        { id, userId: context.userId },
        {
          status: 'blocked',
          completedAt: new Date(),
          result: { ...(job.result ?? {}), halted: true },
        } as QueryDeepPartialEntity<AgentJobEntity>,
      );

      if (message) {
        await this.messageService.create(context, {
          threadId: job.threadId,
          role: 'user',
          model: 'memory',
          source: 'user',
          content: message,
        });
      }

      const updated = await this.requireJob(context, id);
      await this.finishBlocked(context, updated, 'halted');
      return updated;
    }

    if (!message) {
      throw new BadRequestException('Continue and redirect need a message');
    }

    await this.messageService.create(context, {
      threadId: job.threadId,
      role: 'user',
      model: 'memory',
      source: 'user',
      content: input.action === 'redirect' ? `Redirect: ${message}` : message,
    });

    await this.jobRepository.update({ id, userId: context.userId }, { status: 'running' });
    await this.doorbell.wakeOpenClaw(id);

    return this.requireJob(context, id);
  }

  private async finishBlocked(
    context: UserServiceContext,
    job: AgentJob,
    reason: string,
  ): Promise<void> {
    await this.messageService.create(context, {
      threadId: job.threadId,
      role: 'assistant',
      model: 'memory',
      source: 'memory',
      content: `Dispatch blocked. ${reason}`,
    });

    await this.eventService.send(AgentTaskBlockedEvent, {
      userId: context.userId,
      jobId: job.id,
      threadId: job.threadId,
      taskId: job.taskId,
      reason,
    });
    await this.eventService.send(PlanningTaskResultEvent, {
      userId: context.userId,
      jobId: job.id,
      taskId: job.taskId,
      status: 'blocked',
      reason,
    });
    await this.completeEventJob(job, { status: 'blocked', reason });
  }

  private async finishFailed(context: UserServiceContext, job: AgentJob, reason: string): Promise<void> {
    await this.messageService.create(context, {
      threadId: job.threadId,
      role: 'assistant',
      model: 'memory',
      source: 'memory',
      content: `Dispatch failed. ${reason}`,
    });

    await this.eventService.send(PlanningTaskResultEvent, {
      userId: context.userId,
      jobId: job.id,
      taskId: job.taskId,
      status: 'failed',
      reason,
    });
    await this.completeEventJob(job, { status: 'failed', reason });
  }

  private async finishCompleted(context: UserServiceContext, job: AgentJob): Promise<void> {
    if (job.taskId) {
      await this.taskService.update(context, job.taskId, { status: 'done' });
    }

    const resultText =
      typeof job.result?.summary === 'string'
        ? job.result.summary
        : `Dispatch finished for “${job.packet.source.title}”.`;

    await this.messageService.create(context, {
      threadId: job.threadId,
      role: 'assistant',
      model: 'memory',
      source: 'memory',
      content: `✓ ${resultText}`,
    });

    await this.eventService.send(AgentTaskCompletedEvent, {
      userId: context.userId,
      jobId: job.id,
      threadId: job.threadId,
      taskId: job.taskId,
    });
    await this.eventService.send(PlanningTaskResultEvent, {
      userId: context.userId,
      jobId: job.id,
      taskId: job.taskId,
      status: 'completed',
    });
    await this.completeEventJob(job, { status: 'completed' });
  }

  private async completeEventJob(job: AgentJob, output: Record<string, unknown>): Promise<void> {
    if (!job.eventJobId) {
      return;
    }

    await this.eventService.completeJob(AGENT_DISPATCH_QUEUE, job.eventJobId, output);
  }

  private async requireJob(context: UserServiceContext, id: string): Promise<AgentJob> {
    const job = await this.findById(context, id);

    if (!job) {
      throw new NotFoundException(`Dispatch job ${id} not found`);
    }

    return job;
  }
}
