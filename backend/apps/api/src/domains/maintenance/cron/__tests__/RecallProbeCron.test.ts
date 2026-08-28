import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import type { LoggerService } from '@ci/common/logging';

import type { RecallProbeRun } from '../../services/RecallProbeService';
import { RECALL_PROBE_CRON, RecallProbeCron } from '../RecallProbeCron';

/**
 * The schedule is the design here, so it is what is asserted: a probe that runs
 * sequential scans over the whole embedding table has to land inside the
 * enrichment window, after the nightly indexing that fills that table, weekly
 * rather than nightly, on the worker, and on a second nobody else holds.
 */

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: jest.fn(),
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

function makeRun(rows: number): RecallProbeRun {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    capturedAt: new Date('2026-08-23T05:20:13.000Z'),
    userId: rows === 0 ? null : '00000000-0000-0000-0000-0000000000aa',
    types: rows === 0 ? [] : ['note'],
    deferredTypes: [],
    tooSmall: ['event'],
    rows: Array.from({ length: rows }, () => ({}) as RecallProbeRun['rows'][number]),
    deadlineHit: false,
    pruned: 0,
  };
}

function fields(): string[] {
  return RECALL_PROBE_CRON.trim().split(/\s+/);
}

describe('RecallProbeCron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers under its own name, on the worker, weekly', () => {
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, RecallProbeCron.prototype.probeRecall) as {
      name?: string;
      cronTime?: string;
    };

    // The registry key the Jobs dashboard and ci.cron_runs both use. Without an
    // explicit name @nestjs/schedule mints a UUID per boot and the two can
    // never agree — the AccountPurgeCron defect.
    expect(options.name).toBe('RecallProbeCron.probeRecall');
    expect(options.cronTime).toBe(RECALL_PROBE_CRON);

    // Six fields: five would be read as second 0, which is the pile-up the
    // offset exists to avoid.
    expect(fields()).toHaveLength(6);
    // Sunday.
    expect(fields()[5]).toBe('0');
  });

  it('takes a second of the minute nobody else holds', () => {
    const [second, minute, hour] = fields();

    expect(second).not.toBe('0');
    expect(second).toBe('13');

    // Inside the default enrichment window (01:00 + 300 minutes) and after the
    // nightly indexing legs at 02:30 / 03:00 / 03:40 / 04:40.
    expect(Number(hour)).toBeGreaterThanOrEqual(1);
    expect(Number(hour)).toBeLessThan(6);
    expect(Number(hour) * 60 + Number(minute)).toBeGreaterThan(4 * 60 + 40);
  });

  it('registers only where the worker role is served', () => {
    const registersUnder = (served: 'web' | 'worker'): boolean => {
      let registered = false;

      jest.isolateModules(() => {
        jest.doMock('@ci/common/roles', () => ({
          processRole: () => served,
          serves: (target: string) => target === served,
        }));
        // Registration is the subject; the service barrel behind it is a large
        // module graph this test has no use for.
        jest.doMock('../../services/RecallProbeService', () => ({ RecallProbeService: class {} }));

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const module = require('../RecallProbeCron') as typeof import('../RecallProbeCron');

        registered =
          Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, module.RecallProbeCron.prototype.probeRecall) != null;
      });

      jest.dontMock('@ci/common/roles');
      jest.dontMock('../../services/RecallProbeService');

      return registered;
    };

    expect(registersUnder('worker')).toBe(true);
    // Two processes running this would double the sequential scans and write
    // two contradictory measurements of the same week.
    expect(registersUnder('web')).toBe(false);
  });

  it('says so when a run measured nothing, rather than reporting silence as health', async () => {
    const service = { probe: jest.fn(async () => makeRun(0)) };
    const cron = new RecallProbeCron(service as never, noopLogger);

    await cron.probeRecall();

    expect(service.probe).toHaveBeenCalledTimes(1);
    expect(noopLogger.warn).toHaveBeenCalledWith(
      'Recall probe measured nothing',
      expect.objectContaining({
        tooSmall: ['event'],
      }),
    );
  });

  it('stays quiet when it measured something', async () => {
    const service = { probe: jest.fn(async () => makeRun(4)) };
    const cron = new RecallProbeCron(service as never, noopLogger);

    await cron.probeRecall();

    expect(noopLogger.warn).not.toHaveBeenCalled();
  });
});
