import { BadRequestException } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { DataSource, Repository } from 'typeorm';

import { JobControlStore } from '@ci/common/job-controls';

import type { JobSettingEntity } from '../../entities/JobSettingEntity';
import { EventListenerRegistry } from '../../event-registration';
import { JobControlsService } from '../JobControlsService';

/**
 * The settings API, which is the only thing between a text box and the
 * appliance's ability to do work.
 *
 * Three properties are load-bearing:
 *
 *  - **Validation is total before the first write.** A body naming one unknown
 *    queue changes NOTHING, rather than applying the valid half of itself. A
 *    partially applied concurrency change is the kind of thing an operator finds
 *    out about when the box is already hot.
 *  - **A short list of jobs refuse to be switched off.** Not paternalism: they
 *    are the ones whose absence breaks the appliance's ability to tell you it is
 *    broken, or that carry an obligation to the user rather than a workload.
 *  - **What comes back is what the appliance will DO**, not what was typed. Ask
 *    for 8 on a queue that declares 1 and the answer has to say 1.
 */

interface SettingsRow {
  kind: string;
  key: string;
  mode: string | null;
  concurrency: number | null;
  skipped_count: string;
  last_skipped_at: Date | null;
  updated_at: Date;
}

interface Upsert {
  kind: string;
  key: string;
  mode: string | null;
  concurrency: number | null;
  setsMode: boolean;
  setsConcurrency: boolean;
  userId: string | null;
}

interface Harness {
  service: JobControlsService;
  upserts: Upsert[];
  rows: SettingsRow[];
}

function makeHarness(options: { rows?: SettingsRow[]; crons?: string[] } = {}): Harness {
  const rows = options.rows ?? [];
  const upserts: Upsert[] = [];

  const query = (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('INSERT INTO ci.job_settings')) {
      const [kind, key, mode, concurrency, setsMode, setsConcurrency, userId] = params as [
        string,
        string,
        string | null,
        number | null,
        boolean,
        boolean,
        string | null,
      ];

      upserts.push({ kind, key, mode, concurrency, setsMode, setsConcurrency, userId });

      return Promise.resolve([]);
    }

    if (sql.includes('UPDATE ci.job_settings')) {
      return Promise.resolve([]);
    }

    return Promise.resolve(rows.map((row) => ({ ...row })));
  };

  const repository = { query } as unknown as Repository<JobSettingEntity>;

  const schedulerRegistry = {
    getCronJobs: () =>
      new Map(
        (options.crons ?? []).map((name) => [name, { cronTime: { source: '0 */5 * * * *' } }] as const),
      ),
  } as unknown as SchedulerRegistry;

  return {
    service: new JobControlsService(repository, schedulerRegistry),
    upserts,
    rows,
  };
}

function configureStore(rows: SettingsRow[]): Promise<void> {
  return JobControlStore.configure({
    query: (sql: string) =>
      sql.includes('UPDATE ci.job_settings')
        ? Promise.resolve([])
        : Promise.resolve(rows.map((row) => ({ ...row }))),
  } as unknown as DataSource);
}

beforeEach(() => {
  EventListenerRegistry.clear();
  EventListenerRegistry.register(
    'file.uploaded',
    'ImageDescriptionListener',
    'describe',
    'image-description',
  );
  EventListenerRegistry.register('chat.generate', 'ChatGenerateListener', 'generate', 'llm', {
    localConcurrency: 1,
  });
  EventListenerRegistry.register('dead-letter.reap', 'DeadLetterReaperListener', 'reap', 'dead-letter');
});

afterEach(async () => {
  await JobControlStore.configure(null);
  EventListenerRegistry.clear();
});

describe('JobControlsService.update validation', () => {
  it('rejects a queue this build does not have', async () => {
    const { service, upserts } = makeHarness();

    await configureStore([]);

    await expect(
      service.update({ queues: [{ name: 'not-a-queue', mode: 'disabled' }] }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(upserts).toEqual([]);
  });

  it('writes nothing at all when any part of the request is invalid', async () => {
    const { service, upserts } = makeHarness();

    await configureStore([]);

    await expect(
      service.update(
        {
          queues: [
            { name: 'image-description', mode: 'paused' },
            { name: 'not-a-queue', mode: 'disabled' },
          ],
        },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The valid half must not land. Half-applied settings are how an operator
    // ends up believing the box is capped when it is not.
    expect(upserts).toEqual([]);
  });

  it('refuses to switch off a protected schedule, and says why', async () => {
    const { service, upserts } = makeHarness({ crons: ['JobMetricsCollector.sampleOnSchedule'] });

    await configureStore([]);

    await expect(
      service.update(
        { crons: [{ name: 'JobMetricsCollector.sampleOnSchedule', mode: 'disabled' }] },
        'user-1',
      ),
    ).rejects.toThrow(/cannot be switched off/);

    expect(upserts).toEqual([]);
  });

  it('still allows a protected schedule to be switched back ON', async () => {
    const { service, upserts } = makeHarness({ crons: ['JobMetricsCollector.sampleOnSchedule'] });

    await configureStore([]);

    await service.update(
      { crons: [{ name: 'JobMetricsCollector.sampleOnSchedule', mode: 'enabled' }] },
      'user-1',
    );

    // A protection that also blocked re-enabling would strand a row disabled by
    // an older build with no way back.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ kind: 'cron', key: 'JobMetricsCollector.sampleOnSchedule' });
  });

  it('refuses to switch off the dead-letter queue', async () => {
    const { service } = makeHarness();

    await configureStore([]);

    await expect(
      service.update({ queues: [{ name: 'dead-letter', mode: 'paused' }] }, 'user-1'),
    ).rejects.toThrow(/cannot be switched off/);
  });

  it('refuses to DISABLE all non-interactive work globally', async () => {
    const { service } = makeHarness();

    await configureStore([]);

    // A global switch that dropped every non-interactive job would put a silent,
    // appliance-wide hole in the memory system. Heat is solved by pausing.
    await expect(
      service.update({ global: { nonInteractive: 'disabled' as never } }, 'user-1'),
    ).rejects.toThrow(/only "enabled" or "paused"/);
  });

  it('refuses a concurrency of zero rather than treating it as a disable', async () => {
    const { service } = makeHarness();

    await configureStore([]);

    await expect(service.update({ global: { concurrency: 0 } }, 'user-1')).rejects.toThrow(/between 1 and/);
  });

  it('rejects an unknown schedule', async () => {
    const { service } = makeHarness({ crons: ['PlanningJobsCron.todoScan'] });

    await configureStore([]);

    await expect(
      service.update({ crons: [{ name: 'NoSuchCron.tick', mode: 'disabled' }] }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('JobControlsService.update writes', () => {
  it('touches only the field the request named', async () => {
    const { service, upserts } = makeHarness();

    await configureStore([]);

    await service.update({ queues: [{ name: 'image-description', mode: 'paused' }] }, 'user-1');

    // A request that changed a mode must not silently wipe the queue's cap, and
    // vice versa — hence the two "sets" flags in the upsert.
    expect(upserts).toEqual([
      {
        kind: 'queue',
        key: 'image-description',
        mode: 'paused',
        concurrency: null,
        setsMode: true,
        setsConcurrency: false,
        userId: 'user-1',
      },
    ]);
  });

  it('treats an explicit null concurrency as a reset, not as "leave alone"', async () => {
    const { service, upserts } = makeHarness();

    await configureStore([]);

    await service.update({ queues: [{ name: 'image-description', concurrency: null }] }, 'user-1');

    expect(upserts).toEqual([
      {
        kind: 'queue',
        key: 'image-description',
        mode: null,
        concurrency: null,
        setsMode: false,
        setsConcurrency: true,
        userId: 'user-1',
      },
    ]);
  });

  it('writes nothing for an empty patch', async () => {
    const { service, upserts } = makeHarness();

    await configureStore([]);

    await service.update({}, 'user-1');

    expect(upserts).toEqual([]);
  });
});

describe('JobControlsService.get', () => {
  it('reports what the appliance will do, not what was asked for', async () => {
    const { service } = makeHarness();

    await configureStore([
      {
        kind: 'queue',
        key: 'llm',
        mode: null,
        concurrency: 8,
        skipped_count: '0',
        last_skipped_at: null,
        updated_at: new Date(),
      },
    ]);

    const dto = await service.get();
    const llm = dto.queues.find((queue) => queue.name === 'llm');

    expect(llm?.concurrency.value).toBe(8);
    // `llm` declares 1 in code, so 8 is not what happens — and the card has to
    // be able to say so rather than echoing the number back.
    expect(llm?.concurrency.effective).toBe(1);
    expect(llm?.declaredConcurrency).toBe(1);
    expect(llm?.interactive).toBe(true);
  });

  it('marks the protected queue as locked, with its reason', async () => {
    const { service } = makeHarness();

    await configureStore([]);

    const dto = await service.get();
    const deadLetter = dto.queues.find((queue) => queue.name === 'dead-letter');

    expect(deadLetter?.locked).toBe(true);
    expect(deadLetter?.lockedReason).toMatch(/retries/);
  });

  it('distinguishes a globally paused queue from one paused by name', async () => {
    const { service } = makeHarness();

    await configureStore([
      {
        kind: 'global',
        key: 'non_interactive',
        mode: 'paused',
        concurrency: null,
        skipped_count: '0',
        last_skipped_at: null,
        updated_at: new Date(),
      },
    ]);

    const dto = await service.get();
    const image = dto.queues.find((queue) => queue.name === 'image-description');
    const llm = dto.queues.find((queue) => queue.name === 'llm');

    expect(image?.mode).toBe('paused');
    // Which switch to flip to bring it back is a different answer in each case.
    expect(image?.pausedByGlobal).toBe(true);
    expect(llm?.mode).toBe('enabled');
  });

  it('lists what is on a queue, so "what am I switching off?" has an answer', async () => {
    const { service } = makeHarness();

    await configureStore([]);

    const dto = await service.get();
    const image = dto.queues.find((queue) => queue.name === 'image-description');

    expect(image?.jobTypes.map((type) => type.event)).toEqual(['file.uploaded']);
    expect(image?.jobTypes[0]?.label).toBeTruthy();
  });

  it('reports the per-process share the semaphores are actually sized to', async () => {
    const { service } = makeHarness();

    await configureStore([]);

    const dto = await service.get();

    // Unconfigured: the appliance figure must divide back to today's behaviour.
    expect(dto.global.concurrency.effective).toBe(dto.global.concurrency.default);
    expect(dto.topology.perProcessConcurrency * dto.topology.queueWorkerProcesses).toBe(
      dto.global.concurrency.effective,
    );
  });
});
