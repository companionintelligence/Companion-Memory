import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';

import { LoggerService } from '@ci/common/logging';
import { CronRunStore } from '@ci/common/schedule';
import config from '@ci/configuration';

import { AccountPurgeService, type PurgeRunSummary } from '../../services/AccountPurgeService';
import { AccountPurgeCron } from '../AccountPurgeCron';

const emptySummary: PurgeRunSummary = {
  considered: 0,
  purged: 0,
  failed: 0,
  unpinned: 0,
  stalled: 0,
  outcomes: [],
};

function build(
  purgeDueAccounts: jest.Mock,
  reportStalledPurges = jest.fn().mockResolvedValue({ count: 0, oldest: [] }),
) {
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  const service = { purgeDueAccounts, reportStalledPurges } as unknown as AccountPurgeService;

  return { cron: new AccountPurgeCron(service, logger), logger, reportStalledPurges };
}

describe('AccountPurgeCron', () => {
  const enabled = config.accountDeletion.purge.enabled;

  afterEach(() => {
    config.accountDeletion.purge.enabled = enabled;
  });

  it('purges due accounts on a tick', async () => {
    const purgeDueAccounts = jest.fn().mockResolvedValue(emptySummary);
    const { cron } = build(purgeDueAccounts);

    await cron.purgeDueAccounts();

    expect(purgeDueAccounts).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the purge is switched off', async () => {
    config.accountDeletion.purge.enabled = false;

    const purgeDueAccounts = jest.fn().mockResolvedValue(emptySummary);
    const { cron } = build(purgeDueAccounts);

    await cron.purgeDueAccounts();

    expect(purgeDueAccounts).not.toHaveBeenCalled();
  });

  it('still reports accounts left unpurged while the purge is switched off', async () => {
    // An off switch forgotten after an incident would otherwise keep every
    // ended account's data with nothing in the logs to say so.
    config.accountDeletion.purge.enabled = false;

    const { cron, reportStalledPurges } = build(jest.fn().mockResolvedValue(emptySummary));

    await cron.purgeDueAccounts();

    expect(reportStalledPurges).toHaveBeenCalledTimes(1);
  });

  it('does not start a second run while one is still going', async () => {
    // A purge of a large account can outlast the hourly tick. Overlapping runs
    // would have two batch loops deleting the same rows out from under each
    // other; the database advisory lock catches the cross-process case, this
    // catches the cheap one.
    let release: () => void = () => undefined;
    const inFlight = new Promise<PurgeRunSummary>((resolve) => {
      release = () => resolve(emptySummary);
    });

    const purgeDueAccounts = jest.fn().mockReturnValue(inFlight);
    const { cron, logger } = build(purgeDueAccounts);

    const first = cron.purgeDueAccounts();

    await cron.purgeDueAccounts();

    expect(purgeDueAccounts).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('previous run still in progress'));

    release();
    await first;
  });

  it('clears the guard after a failure, so a transient error is not permanent', async () => {
    const purgeDueAccounts = jest
      .fn()
      .mockRejectedValueOnce(new Error('database went away'))
      .mockResolvedValueOnce(emptySummary);

    const { cron, logger } = build(purgeDueAccounts);

    await cron.purgeDueAccounts();

    expect(logger.error).toHaveBeenCalled();

    await cron.purgeDueAccounts();

    expect(purgeDueAccounts).toHaveBeenCalledTimes(2);
  });
});

/**
 * The dashboard joins the live SchedulerRegistry to the durable `ci.cron_runs`
 * row on the schedule name. `@nestjs/schedule` keys the registry on
 * `options.name || crypto.randomUUID()`, so a cron with no explicit name gets a
 * fresh UUID every boot and can never match the stable string the `@Cron`
 * wrapper stamps — "last run —" forever, and no stable name to fire it by hand.
 */
describe('AccountPurgeCron schedule identity', () => {
  const NAME = 'AccountPurgeCron.purgeDueAccounts';

  it('registers with the scheduler under the same name it stamps ci.cron_runs with', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        AccountPurgeCron,
        {
          provide: AccountPurgeService,
          useValue: { purgeDueAccounts: jest.fn().mockResolvedValue(emptySummary) },
        },
        {
          provide: LoggerService,
          useValue: { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();

    try {
      await app.init();

      const registered = Array.from(app.get(SchedulerRegistry).getCronJobs().keys());

      expect(registered).toContain(NAME);

      const record = jest.spyOn(CronRunStore, 'record').mockImplementation(() => undefined);

      try {
        await app.get(AccountPurgeCron).purgeDueAccounts();

        expect(record).toHaveBeenCalledWith(NAME);
      } finally {
        record.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
});
