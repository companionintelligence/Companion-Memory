import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { TASK_STATUSES } from '@ci/domains/planning';

import type { AgentJobStatus } from '../../entities/AgentJobEntity';
import { AgentDispatchService } from '../AgentDispatchService';

describe('AgentDispatchService.checkpoint stop rule', () => {
  const context = { userId: 'user-1' } as never;

  function setup() {
    const job = {
      id: 'job-1',
      userId: 'user-1',
      taskId: 'task-1',
      threadId: 'thread-1',
      harnessId: 'openclaw' as const,
      packetMode: 'both' as const,
      packet: { source: { title: 'Book the dentist' } },
      status: 'running' as AgentJobStatus,
      failStep: null as string | null,
      failCount: 0,
      result: null,
      eventJobId: 'pg-job-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };

    const jobRepository = {
      findOne: jest.fn(async () => job),
      find: jest.fn(async (_args: { where: { status: string } }) => [] as (typeof job)[]),
      update: jest.fn(async (_where: unknown, patch: Partial<typeof job>) => {
        Object.assign(job, patch);
      }),
    };
    const messageService = { create: jest.fn() };
    // `findById` as well as `update`: releaseTask READS the task before handing
    // it back, and a stub with only `update` made that branch un-runnable —
    // the same shape of blind spot that let `delegated` ship untested.
    const task = { id: 'task-1', status: 'delegated', completedAt: null as Date | null };
    const taskService = {
      findById: jest.fn(async () => task),
      update: jest.fn(async (_ctx: unknown, _id: string, patch: { status: string }) => {
        task.status = patch.status;

        return task;
      }),
      // The real `complete` stamps the instant; a stub with only `update` could
      // not tell a raw `{ status: 'done' }` write apart from a real completion.
      complete: jest.fn(async () => {
        task.status = 'done';
        task.completedAt = task.completedAt ?? new Date();

        return task;
      }),
    };
    const eventService = { send: jest.fn(), completeJob: jest.fn() };
    const doorbell = { wakeOpenClaw: jest.fn() };
    const logger = { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn() };

    const service = new AgentDispatchService(
      jobRepository as never,
      { create: jest.fn() } as never,
      messageService as never,
      taskService as never,
      eventService as never,
      doorbell as never,
      logger as never,
    );

    return { job, task, service, jobRepository, messageService, eventService, taskService };
  }

  it('blocks after two hard fails on the same step', async () => {
    const { service, eventService } = setup();

    await service.checkpoint(context, 'job-1', { failed: true, step: 'call-office' });
    const afterTwo = await service.checkpoint(context, 'job-1', { failed: true, step: 'call-office' });

    expect(afterTwo.status).toBe('blocked');
    expect(afterTwo.failCount).toBe(2);
    expect(eventService.send).toHaveBeenCalledWith(
      'planning.task_result',
      expect.objectContaining({ status: 'blocked', reason: 'two_fails:call-office' }),
    );
  });

  it('blocks when OpenClaw says it needs the user', async () => {
    const { service } = setup();

    const updated = await service.checkpoint(context, 'job-1', { needsUser: true });

    expect(updated.status).toBe('blocked');
  });

  it('closes the pgboss row when the job fails', async () => {
    const { service, eventService } = setup();

    const updated = await service.checkpoint(context, 'job-1', {
      status: 'failed',
      step: 'inference',
      turns: [{ role: 'assistant', content: 'Context overflow' }],
    });

    expect(updated.status).toBe('failed');
    expect(eventService.completeJob).toHaveBeenCalledWith('agent', 'pg-job-1', {
      status: 'failed',
      reason: 'inference',
    });
  });

  it('fails queued jobs that never checked in', async () => {
    const { job, service, jobRepository } = setup();
    job.status = 'queued';
    job.createdAt = new Date(Date.now() - 3 * 60 * 1000);
    jobRepository.find = jest.fn(async ({ where }: { where: { status: string } }) =>
      where.status === 'queued' ? [job] : [],
    );

    const closed = await service.failStale();

    expect(closed).toBe(1);
    expect(job.status).toBe('failed');
  });

  /**
   * ═══ delegated WAS A ONE-WAY DOOR ═══
   *
   * `blocked` and `failed` both stamp `completedAt` — the job is over — and
   * `finishCompleted` was the only thing that ever moved the task off
   * `delegated`. So every dispatch that did not succeed left the task delegated
   * forever, and `delegated` is believed by the whole Plan surface: the card
   * hides Schedule and Reschedule, the board refuses to file it as Overdue
   * however old its deadline, the planner will not place a block against it.
   * The work became unreachable by the one person left who could do it.
   */
  it('hands the task back when the job blocks', async () => {
    const { service, task, taskService } = setup();

    await service.checkpoint(context, 'job-1', { needsUser: true });

    expect(taskService.update).toHaveBeenCalledWith(context, 'task-1', { status: 'open' });
    expect(task.status).toBe('open');
  });

  it('hands the task back when the job fails', async () => {
    const { service, task } = setup();

    await service.checkpoint(context, 'job-1', { status: 'failed', step: 'inference' });

    expect(task.status).toBe('open');
  });

  it('hands the task back when the user halts the dispatch', async () => {
    const { service, task } = setup();

    await service.steer(context, 'job-1', { action: 'halt', message: 'I did it myself' });

    expect(task.status).toBe('open');
  });

  it('hands back a task that never checked in, not only one that reported failure', async () => {
    // failStale routes through checkpoint({status:'failed'}), so this is the
    // path a dead harness actually takes — and the one most likely to strand a
    // task, because nobody is watching when it happens.
    const { job, task, service, jobRepository } = setup();
    job.status = 'queued';
    job.createdAt = new Date(Date.now() - 3 * 60 * 1000);
    jobRepository.find = jest.fn(async ({ where }: { where: { status: string } }) =>
      where.status === 'queued' ? [job] : [],
    );

    await service.failStale();

    expect(task.status).toBe('open');
  });

  it('does not resurrect work the owner finished while the harness was away', async () => {
    // Guarded on ACTIVE rather than on exactly `delegated`: a late check-in from
    // a stale job must not undo a decision the user has already made. Without
    // this the hand-back would reopen a task they completed or declined.
    const { service, task, taskService } = setup();
    task.status = 'done';

    await service.checkpoint(context, 'job-1', { status: 'failed', step: 'inference' });

    expect(taskService.update).not.toHaveBeenCalled();
    expect(task.status).toBe('done');
  });

  it('still closes the job when the hand-back throws', async () => {
    // The message, the events and completeJob are what stop OpenClaw retrying
    // forever; a task write that fails must not take them down with it.
    const { service, taskService, eventService } = setup();
    taskService.update = jest.fn(async (_ctx: unknown, _id: string, _patch: { status: string }) => {
      throw new Error('tasks table unreachable');
    });

    const updated = await service.checkpoint(context, 'job-1', { status: 'failed', step: 'inference' });

    expect(updated.status).toBe('failed');
    expect(eventService.completeJob).toHaveBeenCalled();
  });

  it('closes the task when the job completes', async () => {
    const { service, task, taskService, eventService } = setup();

    const updated = await service.checkpoint(context, 'job-1', {
      status: 'completed',
      result: { summary: 'Booked Friday at 9' },
    });

    expect(updated.status).toBe('completed');
    // Through `complete`, not a raw `update({ status: 'done' })`: that wrote the
    // status and nothing else, so a delegated task finished with completed_at
    // NULL — no completion time on the Plan card, and invisible to every
    // consumer keyed on that instant (HBPE's daily rollup among them).
    expect(taskService.complete).toHaveBeenCalledWith(context, 'task-1');
    expect(taskService.update).not.toHaveBeenCalled();
    expect(task.status).toBe('done');
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(eventService.completeJob).toHaveBeenCalledWith('agent', 'pg-job-1', { status: 'completed' });
  });

  it('does not close work the owner already archived while the harness was away', async () => {
    // The same guard releaseTask takes, for the same reason: the harness
    // reports in whenever it finishes, and a late success must not overwrite a
    // decision the user has since made.
    const { service, task, taskService } = setup();
    task.status = 'archived';

    const updated = await service.checkpoint(context, 'job-1', {
      status: 'completed',
      result: { summary: 'Booked Friday at 9' },
    });

    expect(updated.status).toBe('completed');
    expect(taskService.complete).not.toHaveBeenCalled();
    expect(task.status).toBe('archived');
  });
});

/**
 * ═══ THE taskId BRANCH WAS NEVER EXECUTED ═══
 *
 * The suite above mocks `taskService` as `{ update }` only and never calls
 * `dispatch()`, so the two lines that read and re-status the task ran in no
 * test at all. That is how `status: 'delegated'` shipped in four TypeScript
 * layers and zero migrations: nothing here could see the value, and nothing
 * that could see it (the CHECK constraint) was reachable from a mock.
 *
 * These lock the shape of the call. Proving the value SURVIVES Postgres is the
 * job of the round-trip case in
 * `domains/planning/services/__tests__/TaskService.tenancy.integration.test.ts`.
 */
describe('AgentDispatchService.dispatch', () => {
  const context = { userId: 'user-1' } as never;
  const TASK_UUID = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5061';

  function setup(task: { id: string } | null = { id: TASK_UUID }) {
    const saved: Array<Record<string, unknown>> = [];
    const jobRepository = {
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn(async (row: Record<string, unknown>) => {
        saved.push(row);

        return row;
      }),
      update: jest.fn(),
    };
    const threadService = { create: jest.fn(async () => ({ id: 'thread-1' })) };
    const messageService = { create: jest.fn() };
    const taskService = {
      findById: jest.fn(async () => task),
      update: jest.fn(async () => task),
    };
    const eventService = { send: jest.fn(async () => ['pg-job-1']), completeJob: jest.fn() };
    const logger = { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn() };

    const service = new AgentDispatchService(
      jobRepository as never,
      threadService as never,
      messageService as never,
      taskService as never,
      eventService as never,
      { wakeOpenClaw: jest.fn() } as never,
      logger as never,
    );

    return { service, jobRepository, threadService, taskService, saved };
  }

  const input = {
    sourceKind: 'Task',
    sourceId: TASK_UUID,
    title: 'Book the dentist',
    body: 'Any Friday morning',
    taskId: TASK_UUID,
  };

  it('marks the task delegated with a status the tasks table accepts', async () => {
    const { service, taskService } = setup();

    await service.dispatch(context, input);

    expect(taskService.findById).toHaveBeenCalledWith(context, TASK_UUID);
    expect(taskService.update).toHaveBeenCalledWith(context, TASK_UUID, { status: 'delegated' });
    // The literal has to be a member of the vocabulary the entity, the GraphQL
    // enum and migration 20260903225251 all agree on — not a free string.
    expect(TASK_STATUSES).toContain('delegated');
  });

  it('links the job row and the packet to the same raw task uuid', async () => {
    const { service, saved } = setup();

    await service.dispatch(context, input);

    expect(saved[0]?.taskId).toBe(TASK_UUID);
  });

  it('refuses to dispatch against a task the caller cannot see', async () => {
    const { service, taskService, jobRepository } = setup(null);

    await expect(service.dispatch(context, input)).rejects.toBeInstanceOf(NotFoundException);

    expect(taskService.update).not.toHaveBeenCalled();
    expect(jobRepository.save).not.toHaveBeenCalled();
  });

  it('still dispatches when there is no task behind the ask', async () => {
    const { service, taskService, saved } = setup();

    await service.dispatch(context, { ...input, sourceKind: 'NoteType', taskId: null });

    expect(taskService.findById).not.toHaveBeenCalled();
    expect(taskService.update).not.toHaveBeenCalled();
    expect(saved[0]?.taskId).toBeNull();
  });
});

/**
 * A job that has finished, failed, or been halted does not take more work.
 *
 * The harness runs in another process and believes it still owns the job: it
 * retries, and `agent_end` fires after every turn. Without a guard, a late or
 * duplicated callback re-stamps `completedAt`, re-emits the terminal event,
 * re-runs the finish handler, and can drive a closed job back to `running`.
 */
describe('AgentDispatchService terminal-state guard', () => {
  const context = { userId: 'user-1' } as never;

  function setup(overrides: { status?: AgentJobStatus; result?: unknown } = {}) {
    const job = {
      id: 'job-1',
      userId: 'user-1',
      taskId: 'task-1',
      threadId: 'thread-1',
      harnessId: 'openclaw' as const,
      packetMode: 'both' as const,
      packet: { source: { title: 'Book the dentist' } },
      status: (overrides.status ?? 'running') as AgentJobStatus,
      failStep: null as string | null,
      failCount: 0,
      result: overrides.result ?? null,
      eventJobId: 'pg-job-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null as Date | null,
    };

    const jobRepository = {
      findOne: jest.fn(async () => job),
      find: jest.fn(async () => [] as (typeof job)[]),
      update: jest.fn(async (_where: unknown, patch: Partial<typeof job>) => {
        Object.assign(job, patch);
      }),
    };
    const task = { id: 'task-1', status: 'delegated', completedAt: null as Date | null };
    const taskService = {
      findById: jest.fn(async () => task),
      update: jest.fn(async (_ctx: unknown, _id: string, patch: { status: string }) => {
        task.status = patch.status;

        return task;
      }),
      complete: jest.fn(async () => {
        task.status = 'done';

        return task;
      }),
    };
    const messageService = { create: jest.fn() };
    const eventService = { send: jest.fn(), completeJob: jest.fn() };
    const doorbell = { wakeOpenClaw: jest.fn() };
    const logger = { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn() };

    const service = new AgentDispatchService(
      jobRepository as never,
      { create: jest.fn() } as never,
      messageService as never,
      taskService as never,
      eventService as never,
      doorbell as never,
      logger as never,
    );

    return { job, task, service, jobRepository, messageService, eventService, taskService, doorbell };
  }

  const HALTED = { status: 'blocked' as AgentJobStatus, result: { halted: true } };

  it.each([
    ['completed', { status: 'completed' as AgentJobStatus }],
    ['failed', { status: 'failed' as AgentJobStatus }],
    ['halted', HALTED],
  ])('refuses a checkpoint on a %s job instead of reopening it', async (_label, over) => {
    const { service, jobRepository, taskService, eventService } = setup(over);

    await expect(service.checkpoint(context, 'job-1', { status: 'completed' })).rejects.toBeInstanceOf(
      ConflictException,
    );

    // The three things that must NOT have happened: no write, no terminal event
    // replay, and above all no second completion of the user's task.
    expect(jobRepository.update).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
    expect(taskService.complete).not.toHaveBeenCalled();
  });

  it('lets a job blocked on the USER be checkpointed — that is the reply-to-resume path', async () => {
    // `blocked` is not terminal on its own. ChatPage renders it as "OpenClaw
    // stopped and needs you", and answering is how the job continues. Only
    // `result.halted` makes a blocked job final.
    const { service, jobRepository } = setup({ status: 'blocked', result: { reason: 'needs_user' } });

    await expect(service.checkpoint(context, 'job-1', { status: 'completed' })).resolves.toBeDefined();
    expect(jobRepository.update).toHaveBeenCalled();
  });

  it('refuses to steer a halted job back to running — the owner said stop', async () => {
    // The worst case the guard exists for. `finishBlocked` releases the task
    // back to `open`, so `taskService.complete`'s own active-status check would
    // PASS on a re-entry: without this, the agent the owner just halted marks
    // their task done.
    const { service, jobRepository, doorbell } = setup(HALTED);

    await expect(
      service.steer(context, 'job-1', { action: 'continue', message: 'carry on' } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(jobRepository.update).not.toHaveBeenCalled();
    expect(doorbell.wakeOpenClaw).not.toHaveBeenCalled();
  });

  it('treats halting an already-halted job as a no-op, not an error', async () => {
    // Pressing Stop twice is not a mistake to report. Re-running the halt would
    // write a second thread message and release the task again.
    const { service, jobRepository, messageService } = setup(HALTED);

    await expect(service.steer(context, 'job-1', { action: 'halt' } as never)).resolves.toBeDefined();
    expect(jobRepository.update).not.toHaveBeenCalled();
    expect(messageService.create).not.toHaveBeenCalled();
  });

  it('refuses the packet fetch on a halted job, which is how the harness learns it stopped', async () => {
    // The packet body carries no status, so a 409 here is the ONLY in-band
    // signal a halt can reach the harness by. The plugin fetches the packet
    // before it checkpoints, so this is the point where it finds out.
    const { service } = setup(HALTED);

    await expect(service.getPacket(context, 'job-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('still serves the packet for a running job', async () => {
    const { service } = setup({ status: 'running' });

    await expect(service.getPacket(context, 'job-1')).resolves.toBeDefined();
  });
});

describe('AgentDispatchService: only the harness may fetch a packet or checkpoint', () => {
  const context = { userId: 'user-1' } as never;

  function setup() {
    const job = {
      id: 'job-1',
      userId: 'user-1',
      taskId: 'task-1',
      threadId: 'thread-1',
      harnessId: 'openclaw' as const,
      packetMode: 'both' as const,
      packet: { source: { title: 'Book the dentist' }, ask: 'Book it' },
      status: 'running' as AgentJobStatus,
      failStep: null as string | null,
      failCount: 0,
      result: null,
      eventJobId: 'pg-job-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null as Date | null,
    };
    const jobRepository = {
      findOne: jest.fn(async () => job),
      find: jest.fn(async () => []),
      update: jest.fn(async (_where: unknown, patch: Partial<typeof job>) => {
        Object.assign(job, patch);
      }),
    };
    const task = { id: 'task-1', status: 'delegated', completedAt: null as Date | null };
    const taskService = {
      findById: jest.fn(async () => task),
      update: jest.fn(async () => task),
      complete: jest.fn(async () => {
        task.status = 'done';

        return task;
      }),
    };
    const messageService = { create: jest.fn() };
    const eventService = { send: jest.fn(), completeJob: jest.fn() };
    const service = new AgentDispatchService(
      jobRepository as never,
      { create: jest.fn() } as never,
      messageService as never,
      taskService as never,
      eventService as never,
      { wakeOpenClaw: jest.fn() } as never,
      { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn() } as never,
    );

    return { job, task, service, messageService, taskService };
  }

  const openclawKey = { kind: 'api-key' as const, connectApp: 'ci-openclaw' };

  it("serves the packet to the OpenClaw app's key", async () => {
    const { service } = setup();

    await expect(service.getPacket(context, 'job-1', openclawKey)).resolves.toMatchObject({ ask: 'Book it' });
  });

  it("refuses another installed app's key, e.g. a memory-only voice speaker", async () => {
    const { service } = setup();

    await expect(
      service.getPacket(context, 'job-1', { kind: 'api-key', connectApp: 'ci-ha-voice' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a key the connect flow did not mint, even one the owner made', async () => {
    const { service } = setup();

    await expect(
      service.getPacket(context, 'job-1', { kind: 'api-key', connectApp: null }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a checkpoint from another app's key, and neither writes a turn nor completes the task", async () => {
    const { service, messageService, taskService } = setup();

    await expect(
      service.checkpoint(
        context,
        'job-1',
        { status: 'completed', turns: [{ role: 'assistant', content: 'Done' }] },
        {
          kind: 'api-key',
          connectApp: 'ci-mentra',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(messageService.create).not.toHaveBeenCalled();
    expect(taskService.complete).not.toHaveBeenCalled();
  });

  it("accepts the OpenClaw app's checkpoint", async () => {
    const { service, taskService } = setup();

    await service.checkpoint(context, 'job-1', { status: 'completed' }, openclawKey);

    expect(taskService.complete).toHaveBeenCalledTimes(1);
  });

  it('lets the owner signed in, and the stale-job sweep, act without a key', async () => {
    const { service } = setup();

    await expect(service.getPacket(context, 'job-1', { kind: 'owner' })).resolves.toBeDefined();
    await expect(service.getPacket(context, 'job-1')).resolves.toBeDefined();
  });
});
