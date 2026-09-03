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
      status: 'running' as const,
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
