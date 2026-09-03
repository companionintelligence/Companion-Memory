import { NotFoundException } from '@nestjs/common';

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
    const taskService = { update: jest.fn() };
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

    return { job, service, jobRepository, messageService, eventService, taskService };
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

  it('closes the task when the job completes', async () => {
    const { service, taskService, eventService } = setup();

    const updated = await service.checkpoint(context, 'job-1', {
      status: 'completed',
      result: { summary: 'Booked Friday at 9' },
    });

    expect(updated.status).toBe('completed');
    expect(taskService.update).toHaveBeenCalledWith(context, 'task-1', { status: 'done' });
    expect(eventService.completeJob).toHaveBeenCalledWith('agent', 'pg-job-1', { status: 'completed' });
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
