import type { RequestContext } from '@ci/common/context';

import { expectFixtureShapes } from '../../__tests__/support/cliWireFixtures';
import { JobsController } from '../controllers/JobsController';
import type { JobControlsService } from '../services/JobControlsService';
import type { JobDashboardDto, JobMonitorService } from '../services/JobMonitorService';
import type { JobQueryService } from '../services/JobQueryService';

/**
 * `ci audit jobs` against `GET /jobs/dashboard`, through the fixture both
 * suites read (see `__tests__/support/cliWireFixtures.ts`).
 *
 * The route hands back what `JobMonitorService.getDashboard` builds, and that
 * reads four pg-boss tables. So the body here is a literal typed as
 * `JobDashboardDto`: a change to the DTO stops this compiling, and the shape
 * check then sends whoever changed it to the fixture, and through it to the
 * CLI's tests.
 */

const OWNER = '00000000-0000-4000-8000-000000000001';

const dashboard: JobDashboardDto = {
  summary: {
    pending: 5,
    active: 2,
    retry: 1,
    completed: 40,
    failed: 3,
    cancelled: 0,
    deadLettered: 1,
    scheduled: 0,
  },
  archiveDistribution: [{ jobName: 'hbpe-scheduled', count: 40 }],
  activeDistribution: [{ jobName: 'hbpe-scheduled', count: 2 }],
  queueDistribution: [{ queue: 'hbpe-scheduled', count: 7 }],
  smartRotationDistribution: [{ workType: 'answer-inference', count: 1 }],
  jobs: [
    {
      id: '0193a3c4-0000-7000-8000-0000000000a1',
      queue: 'hbpe-scheduled',
      state: 'active',
      priority: 0,
      retryLimit: 2,
      retryCount: 0,
      retryDelay: 60,
      retryBackoff: true,
      createdOn: '2026-11-12T03:00:00.000Z',
      startAfter: '2026-11-12T03:00:00.000Z',
      startedOn: '2026-11-12T03:00:02.000Z',
      deadLetter: 'dead-letter',
      policy: 'standard',
      event: 'hbpe.nightly',
      workType: null,
      payloadBytes: 96,
      failure: null,
    },
  ],
  archive: [
    {
      id: '0193a3c4-0000-7000-8000-0000000000a2',
      queue: 'hbpe-scheduled',
      state: 'failed',
      priority: 0,
      retryLimit: 2,
      retryCount: 2,
      retryDelay: 60,
      retryBackoff: true,
      createdOn: '2026-11-11T03:00:00.000Z',
      startAfter: '2026-11-11T03:00:00.000Z',
      startedOn: '2026-11-11T03:00:02.000Z',
      completedOn: '2026-11-11T03:04:00.000Z',
      deadLetter: 'dead-letter',
      policy: 'standard',
      event: 'hbpe.nightly',
      workType: null,
      payloadBytes: 96,
      failure: { message: 'sidecar returned 503', failedAt: '2026-11-11T03:04:00.000Z' },
      archivedOn: '2026-11-11T03:04:00.000Z',
    },
  ],
  schedules: [],
  crons: [
    {
      name: 'PythonFunctionCrons.hbpeNightly',
      cron: '0 3 * * *',
      timezone: null,
      running: true,
      nextRunAt: '2026-11-13T03:00:00.000Z',
      lastRunAt: '2026-11-12T03:00:00.000Z',
      lastSuccessAt: '2026-11-12T03:00:00.000Z',
      overdue: false,
      disabled: false,
      role: 'worker',
      servedHere: true,
    },
  ],
  queues: [
    {
      name: 'hbpe-scheduled',
      policy: 'standard',
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 14400,
      retentionMinutes: null,
      deadLetter: 'dead-letter',
      createdOn: '2026-08-01T00:00:00.000Z',
      updatedOn: '2026-11-01T00:00:00.000Z',
    },
  ],
};

describe('the ci CLI against /jobs/dashboard', () => {
  it('answers in the shape the CLI is tested against', async () => {
    const controller = new JobsController(
      { getDashboard: jest.fn(async () => dashboard) } as unknown as JobMonitorService,
      {} as JobQueryService,
      {} as JobControlsService,
    );

    expectFixtureShapes('jobs.json', {
      dashboard: await controller.getDashboard({ userId: OWNER } as RequestContext),
    });
  });
});
