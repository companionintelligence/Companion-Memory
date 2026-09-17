import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository, type QueryDeepPartialEntity } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { EventService, INTERACTIVE_JOB_PRIORITY } from '@ci/domains/events';
import { TaskService, isActiveTaskStatus } from '@ci/domains/planning';

import { AGENT_DISPATCH_QUEUE, DISPATCH_QUEUED_STALE_MS, DISPATCH_RUNNING_STALE_MS } from '../constants';
import { buildDispatchPacket } from '../dispatchPacket';
import {
  AgentJobEntity,
  type AgentJob,
  type AgentJobStatus,
  type PacketMode,
} from '../entities/AgentJobEntity';
import {
  AgentTaskBlockedEvent,
  AgentTaskCheckpointEvent,
  AgentTaskCompletedEvent,
  AgentTaskDispatchEvent,
  PlanningTaskResultEvent,
} from '../events';

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

    const taskId = input.taskId ?? null;

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
      await this.jobRepository.update({ id: jobId }, {
        eventJobId,
      } as QueryDeepPartialEntity<AgentJobEntity>);
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

    // The harness fetches the packet before it checkpoints, which makes this the
    // one place a halt can actually reach it: the packet body carries no status,
    // so a 409 here is the only in-band way to say "stop, this is over". Without
    // it a halted job is undetectable from the harness side and the agent
    // cheerfully finishes work the owner told it to abandon.
    assertResumable(job, 'fetch the packet for');

    if (job.status === 'queued') {
      await this.jobRepository.update({ id, userId: context.userId }, { status: 'running' });
    }

    return job.packet;
  }

  async checkpoint(context: UserServiceContext, id: string, input: CheckpointInput): Promise<AgentJob> {
    const job = await this.requireJob(context, id);

    // A terminal job does not accept more work. Without this, a late or
    // duplicated callback — the harness retries, or `agent_end` fires once more
    // after the job already finished — re-stamps `completedAt`, re-emits the
    // terminal event, re-runs `finishCompleted` (which marks the TASK done a
    // second time), and can drive a closed job back to `running`.
    //
    // Worst of the four: a halted job. `finishBlocked` releases the task back to
    // `open`, so `taskService.complete`'s own active-status guard passes — and
    // the agent the owner just told to stop marks their task done.
    assertResumable(job, 'checkpoint');

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

    await this.jobRepository.update({ id, userId: context.userId }, {
      status,
      failStep,
      failCount,
      result: input.result ?? job.result,
      completedAt: completed ? new Date() : job.completedAt,
    } as QueryDeepPartialEntity<AgentJobEntity>);

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
              content: 'OpenClaw did not check in. Memory closed the job so it would not hang.',
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

    // Halting an already-halted job is the user pressing Stop twice — idempotent,
    // not an error, and it must not re-run `finishBlocked` (which would release
    // the task and write a second thread message).
    if (input.action === 'halt' && isHalted(job)) {
      return job;
    }

    // Everything else needs a job that can still move. Continue/redirect on a
    // finished job would set `status: 'running'` on a row with a `completedAt`
    // and ring the doorbell for work that is over.
    assertResumable(job, input.action);

    if (input.action === 'halt') {
      await this.jobRepository.update({ id, userId: context.userId }, {
        status: 'blocked',
        completedAt: new Date(),
        result: { ...(job.result ?? {}), halted: true },
      } as QueryDeepPartialEntity<AgentJobEntity>);

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

  private async finishBlocked(context: UserServiceContext, job: AgentJob, reason: string): Promise<void> {
    await this.messageService.create(context, {
      threadId: job.threadId,
      role: 'assistant',
      model: 'memory',
      source: 'memory',
      content: `Dispatch blocked. ${reason}`,
    });

    await this.releaseTask(context, job);

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
    await this.releaseTask(context, job);

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

  /**
   * ═══ A DISPATCH THAT ENDS BADLY MUST HAND THE TASK BACK ═══
   *
   * `blocked` and `failed` are terminal for the job — both stamp `completedAt`,
   * and `finishCompleted` is the only thing that ever moved the task off
   * `delegated`. So every dispatch that did not succeed left the task delegated
   * forever, which is worse than it sounds: `delegated` means "an agent has
   * this", and the whole Plan surface believes it. The card hides Schedule and
   * Reschedule, the board refuses to file it as Overdue however old its
   * deadline, and the planner will not place a calendar block against it. The
   * work became unreachable by the one person left who could do it.
   *
   * Returning it to `open` says the truth: nobody has this, it is yours again.
   *
   * Guarded on the task still being ACTIVE, not on it being exactly
   * `delegated`, so this cannot resurrect work the owner has since completed,
   * declined or archived while the harness was away — a stale job checking in
   * late must not undo a decision the user has already made.
   */
  private async releaseTask(context: UserServiceContext, job: AgentJob): Promise<void> {
    if (!job.taskId) {
      return;
    }

    try {
      const task = await this.taskService.findById(context, job.taskId);

      if (!task || !isActiveTaskStatus(task.status)) {
        return;
      }

      await this.taskService.update(context, job.taskId, { status: 'open' });
    } catch (error) {
      // Never let the hand-back stop the job from closing: the message, the
      // events and completeJob below are what stop OpenClaw retrying forever.
      this.logger.warn('Could not release the task from a failed dispatch', {
        jobId: job.id,
        taskId: job.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * ═══ A SUCCESSFUL DISPATCH CLOSES THE TASK THE SAME WAY A PERSON DOES ═══
   *
   * This used to write `{ status: 'done' }` through `update`, which is a raw
   * `Object.assign` onto the row: the task landed in the Done column with
   * `completed_at` still NULL, so the card showed no completion time and every
   * consumer keyed on that instant (HBPE's daily rollup among them) could never
   * see the agent's work. `TaskService.complete` is the documented path and
   * stamps it.
   *
   * Guarded on the task still being ACTIVE for the same reason
   * {@link releaseTask} is: the harness reports in whenever it finishes, and a
   * late success must not overwrite a decision the owner made in the meantime —
   * archiving the task, or completing it themselves.
   */
  private async finishCompleted(context: UserServiceContext, job: AgentJob): Promise<void> {
    if (job.taskId) {
      const task = await this.taskService.findById(context, job.taskId);

      if (task && isActiveTaskStatus(task.status)) {
        await this.taskService.complete(context, job.taskId);
      }
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

/**
 * Did the owner explicitly stop this job?
 *
 * A halt writes `status: 'blocked'` with `result.halted`, which is
 * indistinguishable by any WHERE clause from "blocked, waiting for the user" —
 * the two mean opposite things and only the jsonb flag separates them. So the
 * check reads the flag rather than the status, and `AgentJobStatus` keeps its
 * five values (widening the CHECK is a migration, an entity union and frontend
 * copy; see the open question on the W5 issue).
 */
function isHalted(job: AgentJob): boolean {
  return job.status === 'blocked' && (job.result as { halted?: boolean } | null)?.halted === true;
}

/**
 * Can this job still take instructions?
 *
 * `blocked` is deliberately NOT terminal on its own. A job blocked on
 * `needs_user` or `two_fails` is the designed reply-to-resume path — ChatPage
 * renders it as "OpenClaw stopped and needs you", and steering it is how the
 * user answers. Only three states are genuinely over: it finished, it failed,
 * or the owner halted it.
 */
function isResumable(job: AgentJob): boolean {
  return job.status !== 'completed' && job.status !== 'failed' && !isHalted(job);
}

/**
 * Refuse an operation on a job that is over.
 *
 * A 409 rather than a silent no-op on purpose: the caller is a harness in
 * another process that believes it still owns this job, and it needs to be told
 * it does not. Swallowing the write would leave it working on indefinitely.
 */
function assertResumable(job: AgentJob, operation: string): void {
  if (isResumable(job)) {
    return;
  }

  const state = isHalted(job) ? 'halted by its owner' : job.status;

  throw new ConflictException(`Cannot ${operation} job ${job.id}: it is ${state}.`);
}
